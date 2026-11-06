/** Packaged renderer graph continuation and exact retained-history engineering QA.
 * Node24; explicit LOCI_PACKAGED_APP, LOCI_QA_PYTHON, LOCI_QA_OUTPUT_ROOT,
 * LOCI_QA_SOURCE_COMMIT. Lead-owned loader must place the window on a secondary
 * display; optional LOCI_QA_DISPLAY_ID pins it. No primary-display fallback.
 * Optional LOCI_QA_TISSUE_INPUTS points to the authorized local INPUTS.json.
 * All analyses use actual packaged window.lociResearch. Python only creates the
 * authored TIFF and independently reads retained arrays/golden artifacts.
 * Picker responses are simulated: this is NOT native picker acceptance, human
 * scientific approval, model qualification, or a Codex-host journey.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { createEmptyStudy, fileMenuAction, selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const env = process.env, exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin');
assert.equal(process.versions.node.split('.')[0], '24', 'Use supported Node24');
for (const name of ['LOCI_PACKAGED_APP', 'LOCI_QA_PYTHON', 'LOCI_QA_OUTPUT_ROOT'])
  assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be an explicit absolute path`);
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/u);
if (env.LOCI_QA_TISSUE_INPUTS) assert.ok(path.isAbsolute(env.LOCI_QA_TISSUE_INPUTS));
const output = await fs.mkdtemp(path.join(env.LOCI_QA_OUTPUT_ROOT, 'workflow-graph-expansion-'));
const source = path.join(output, 'authored.ome.tif'), study = path.join(output, 'authored.loci-study');
const restored = path.join(output, 'restored.loci-study'), portable = path.join(output, 'portable.zip');
const executablePath = path.join(env.LOCI_PACKAGED_APP, 'Contents/MacOS/Loci');
const sha = async file => {
  assert.equal((await fs.lstat(file)).isFile(), true, `Expected regular file: ${file}`);
  const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
};
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const id = () => randomUUID().replaceAll('-', '');
const bound = value => ({ result_id: value.id, revision_hash: value.revision_hash });
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  .replace(/[\u007f-\uffff]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const receipt = {
  schema: 'loci.workflow-graph-expansion-packaged-qa/v1', status: 'running', output,
  started_at: new Date().toISOString(), source_commit: env.LOCI_QA_SOURCE_COMMIT,
  scientific_qualification: 'not-established', human_scientific_review: false,
  limits: ['All path picker selections are harness simulations; no real native dialog acceptance.',
    'Renderer clicks are automated technical actions, not human scientific approval.',
    'Continuation is a deliberate stopped-run handoff; this does not simulate a host crash or transfer agent authority.',
    'The synthetic YX fixture checks exact values and state contracts, not biological accuracy or 3D behavior.',
    'Optional tissue golden arrays establish deterministic regression, not an independent accuracy reference.',
    'Cold reads do not instrument decoder imports; optional cold session has a fresh empty model cache.'],
  checks: [], dialogs: [], screenshots: [], renderer_errors: [], network_requests: [], processes: [],
  optional_tissue: { requested: Boolean(env.LOCI_QA_TISSUE_INPUTS), status: env.LOCI_QA_TISSUE_INPUTS ? 'pending' : 'not-requested' },
};
let app, page, failure, timer, scans = Promise.resolve(), session = 0;
let pickers = { study, openStudy: study, source, archive: portable, restored };
const owned = new Map();
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
const api = (name, args = []) => page.evaluate(({ name, args }) => {
  if (typeof window.lociResearch[name] !== 'function') throw new Error(`Required packaged API unavailable: ${name}`);
  return window.lociResearch[name](...args);
}, { name, args });
async function wait(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await read(); if (accept(last)) return last;
    const error = page?.getByRole('region', { name: 'Composed workflows', exact: true }).getByRole('alert');
    if (error && await error.count()) throw new Error(`${label}: ${await error.allTextContents()}`);
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: timed out; last=${JSON.stringify(last)}`);
}
async function shot(name) {
  const file = path.join(output, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' });
  receipt.screenshots.push({ name, sha256: await sha(file) });
}
async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/u); return [Number(fields[0]), { parent: Number(fields[1]), start: fields.slice(2).join(' ') }];
  }));
}
async function remember() {
  if (!app) return;
  const table = await processTable(), roots = new Set([app.process().pid]);
  for (const [pid, start] of owned) if (table.get(pid)?.start === start) roots.add(pid);
  for (;;) {
    const count = roots.size;
    for (const [pid, value] of table) if (roots.has(value.parent)) roots.add(pid);
    if (count === roots.size) break;
  }
  for (const pid of roots) if (table.has(pid)) owned.set(pid, table.get(pid).start);
}
async function installPickers() {
  await app.evaluate(({ dialog }, values) => {
    globalThis.__graphQAPickers = values; globalThis.__graphQADialogs ??= [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title, p = globalThis.__graphQAPickers;
      const selected = { 'Open research study': p.openStudy, 'Add microscopy or medical images': p.source,
        'Import portable Loci study': p.archive, 'Relink an exact local copy of the source': p.source,
        'Import exact PUMA network weights': p.weights, 'Select the exact PUMA conversion receipt': p.conversion }[title];
      if (!selected) throw new Error('Unexpected simulated open picker: ' + title);
      globalThis.__graphQADialogs.push({ title, simulation: true, selected_basename: selected.split('/').at(-1) });
      return { canceled: false, filePaths: [selected] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title, p = globalThis.__graphQAPickers;
      const selected = { 'Create research study': p.study, 'Export portable study with derived results': p.archive,
        'Choose a new study directory': p.restored }[title];
      if (!selected) throw new Error('Unexpected simulated save picker: ' + title);
      globalThis.__graphQADialogs.push({ title, simulation: true, selected_basename: selected.split('/').at(-1) });
      return { canceled: false, filePath: selected };
    };
    // No message box is auto-approved. Unexpected confirmations remain visible.
  }, pickers);
}
async function launch() {
  const profile = path.join(output, `profile-${++session}`);
  app = await electron.launch({ executablePath, cwd: path.join(repo, 'desktop'), timeout: 120000,
    args: ['--user-data-dir=' + profile], env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await remember(); timer = setInterval(() => { scans = scans.then(remember).catch(error => { receipt.process_tracking_error = error.message; }); }, 500);
  await page.waitForFunction(() => Boolean(window.lociResearch));
  const placement = await app.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getBounds();
    return { bounds, display: screen.getDisplayMatching(bounds).id, primary: screen.getPrimaryDisplay().id };
  });
  assert.notEqual(placement.display, placement.primary, 'Lead display loader must place Loci on the secondary display; no fallback');
  if (env.LOCI_QA_DISPLAY_ID) assert.equal(String(placement.display), env.LOCI_QA_DISPLAY_ID);
  receipt.checks.push({ name: 'secondary-display-placement', session, ...placement });
  await installPickers();
}
async function close() {
  clearInterval(timer); await scans;
  if (!app) return;
  await remember(); receipt.dialogs.push(...await app.evaluate(() => globalThis.__graphQADialogs ?? []));
  const closing = app, done = closing.waitForEvent('close', { timeout: 30000 });
  let closeError;
  try { await closing.evaluate(({ app }) => app.quit()); await done; }
  catch (error) { closeError = error; await closing.close().catch(() => {}); }
  finally { app = undefined; page = undefined; }
  let table = await processTable();
  for (let attempt = 0; attempt < 20 && [...owned].some(([pid, start]) => table.get(pid)?.start === start); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100)); table = await processTable();
  }
  let remaining = [...owned].filter(([pid, start]) => table.get(pid)?.start === start);
  const record = { session, observed: [...owned].map(([pid, start]) => ({ pid, start })), survivors_after_quit: remaining.map(([pid]) => pid) };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const [pid, start] of remaining) if ((await processTable()).get(pid)?.start === start)
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (remaining.length) await new Promise(resolve => setTimeout(resolve, 500));
    table = await processTable(); remaining = [...owned].filter(([pid, start]) => table.get(pid)?.start === start);
  }
  record.final_survivors = remaining.map(([pid]) => pid); receipt.processes.push(record); owned.clear();
  assert.deepEqual(record.final_survivors, []); assert.deepEqual(record.survivors_after_quit, [], 'Ordinary quit required forced cleanup');
  if (closeError) throw closeError;
}
async function identity() {
  const root = path.join(env.LOCI_PACKAGED_APP, 'Contents/Resources');
  return { executable: await sha(executablePath), asar: await sha(path.join(root, 'app.asar')),
    worker: await sha(path.join(root, 'loci-engine/loci-engine')), manifest: await readJson(path.join(root, 'loci-build-identity.json')) };
}
async function nativeTask(operation, request) {
  const result = await execute(operation, request);
  assert.equal(result.job?.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.job.operation, operation); assert.equal(result.job.owner ?? null, null);
  assert.deepEqual(result.job.result_ids, [result.result.id]); return result;
}
const graphRuns = async () => (await execute('workflow_graph_runs')).runs;
const graphById = async runId => {
  const run = (await graphRuns()).find(item => item.id === runId); assert.ok(run, `Saved graph missing: ${runId}`); return run;
};
async function openGraph(workflowId, choices, activeSourceId) {
  // API setup writes do not update React props. Reopen through the real UI so
  // the result/preview selectors receive the actual current snapshot.
  await fileMenuAction(page, 'Open study');
  await page.locator('main.image-first-workbench').waitFor();
  if (activeSourceId) await page.locator(`button[data-source-id="${activeSourceId}"]`).click();
  await selectWorkbenchTool(page, 'Workflow');
  const disclosure = page.locator('details.composed-workflows');
  if (!await disclosure.evaluate(element => element.open)) await disclosure.locator('summary').click();
  const panel = page.getByRole('region', { name: 'Composed workflows', exact: true });
  await panel.getByRole('button', { name: 'Refresh composed workflows', exact: true }).click();
  await wait(() => panel.getByLabel('Saved composed workflow', { exact: true }).locator(`option[value="${workflowId}"]`).count(), Boolean, 'saved graph renderer library');
  await panel.getByLabel('Saved composed workflow', { exact: true }).selectOption(workflowId);
  for (const [name, value] of Object.entries(choices)) {
    const input = panel.getByLabel(`Workflow input ${name}`, { exact: true });
    await wait(() => input.locator(`option[value="${value}"]`).count(), Boolean, `exact selectable ${name}`);
    await input.selectOption(value);
  }
  await panel.getByRole('button', { name: 'Check inputs', exact: true }).click();
  await wait(() => panel.getByRole('button', { name: 'Run composed workflow', exact: true }).isEnabled(), Boolean, 'exact UI graph preflight');
  return panel;
}
function reportNode(prediction, reference, prefix = 'b_agreement') {
  return { id: prefix, operation: 'annotation_evaluation_run', contract_version: 1,
    inputs: { prediction, reference }, settings: { semantics: 'instances', iou_thresholds: [0.5, 0.75],
      reference_declaration: 'Authored complete technical reference; not biological ground truth', working_bytes: 64 * 1024**2 } };
}
async function saveDefinition(definition) {
  return (await execute('workflow_graph_save', { workflow_id: id(), expected_revision: 0, definition })).workflow;
}
async function inspected(result) {
  const record = await execute('result', { result_id: result.id, offset: 0, limit: 1000 });
  assert.equal(record.result.revision_hash, result.revision_hash); return record;
}
async function oracle(mode, config) {
  const filename = path.join(output, `oracle-${mode}-${randomUUID()}.json`); await writeJson(filename, config);
  const result = await exec(env.LOCI_QA_PYTHON, ['-I', '-c', oracleCode, mode, filename], { cwd: output, timeout: 30000, maxBuffer: 4 * 1024**2 });
  const parsed = JSON.parse(result.stdout); await writeJson(filename.replace('.json', '-receipt.json'), parsed); return parsed;
}
const oracleCode = String.raw`
import hashlib,json,sys
from pathlib import Path
import numpy as np
import tifffile
mode=sys.argv[1]; c=json.loads(Path(sys.argv[2]).read_text())
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
expected=np.zeros((32,32),np.uint16); expected[4:12,4:12]=100; expected[20:24,20:28]=200
if mode=='setup':
 tifffile.imwrite(c['source'],expected,ome=True,metadata={'axes':'YX','PhysicalSizeX':1.0,'PhysicalSizeY':1.0,'PhysicalSizeXUnit':'µm','PhysicalSizeYUnit':'µm'})
 print(json.dumps({'source_sha256':digest(c['source']),'shape':[32,32],'foreground_pixels':96,'objects':2,'intensity_means':[100,200]}))
else:
 def arrays(result):
  out={}
  for key,d in result['arrays'].items():
   p=Path(c['study'])/'artifacts'/(d['sha256']+'.npy'); assert digest(p)==d['sha256']
   a=np.load(p,allow_pickle=False); assert list(a.shape)==d['shape'] and str(a.dtype)==d['dtype']; out[key]=a
  return out
 if mode=='synthetic':
  values={key:arrays(value) for key,value in c['results'].items()}
  for name,a in values.items():
   np.testing.assert_array_equal(a['image'],expected)
   np.testing.assert_array_equal(a['labels']>0,expected>0)
   assert len(np.unique(a['labels'][a['labels']>0]))==2
  np.testing.assert_array_equal(values['report']['labels'],values['prediction']['labels'])
  np.testing.assert_array_equal(values['report']['reference_labels'],values['reference']['labels'])
  print(json.dumps({'status':'passed','foreground_pixels':96,'objects':2,'all_artifact_hashes_verified':True}))
 elif mode=='tissue':
  a=arrays(c['result']); expected_classes=np.load(c['classes'],allow_pickle=False); expected_probabilities=np.load(c['probabilities'],allow_pickle=False)
  assert a['class_labels'].dtype==expected_classes.dtype and a['class_labels'].tobytes()==expected_classes.tobytes()
  assert a['probabilities'].dtype==expected_probabilities.dtype and a['probabilities'].tobytes()==expected_probabilities.tobytes()
  np.testing.assert_array_equal(a['labels']>0,a['class_labels']==4)
  assert a['image'].tobytes()==a['probabilities'][4].tobytes()
  print(json.dumps({'status':'passed','class_labels_bitwise_equal':True,'probabilities_bitwise_equal':True,'all_artifact_hashes_verified':True}))
 else: raise AssertionError('Unknown oracle mode')
`;

async function optionalTissue() {
  if (!env.LOCI_QA_TISSUE_INPUTS) return;
  const record = receipt.optional_tissue, manifest = await readJson(env.LOCI_QA_TISSUE_INPUTS);
  record.input_manifest_sha256 = await sha(env.LOCI_QA_TISSUE_INPUTS); record.inputs = {};
  for (const key of ['source', 'weights', 'conversion_receipt', 'reference_receipt', 'reference_classes', 'reference_probabilities']) {
    const entry = manifest.inputs?.[key]; assert.ok(entry && path.isAbsolute(entry.path), `Missing exact authorized input: ${key}`);
    assert.equal((await fs.stat(entry.path)).size, entry.bytes); assert.equal(await sha(entry.path), entry.sha256);
    record.inputs[key] = entry;
  }
  const values = manifest.inputs, golden = (await readJson(values.reference_receipt.path)).backend;
  const tissueSource = path.join(output, 'TRAINING004.tif'); await fs.copyFile(values.source.path, tissueSource);
  pickers = { ...pickers, source: tissueSource, weights: values.weights.path, conversion: values.conversion_receipt.path };
  await installPickers(); await api('addSources', ['files']);
  const src = (await snapshot()).sources.find(item => item.sha256 === values.source.sha256); assert.ok(src);
  const profiles = await execute('tissue_model_profiles'); const profile = profiles.profiles[0].profile;
  assert.equal(profile.model.sha256, values.weights.sha256); assert.equal(profile.model.conversion_receipt_sha256, values.conversion_receipt.sha256);
  await api('importTissueModel', ['puma-tissue-cpu']);
  const ready = await execute('tissue_model_profiles'); assert.ok(ready.profiles[0].store.provisioned);
  assert.equal(ready.profiles[0].runtime.status, 'metadata-matches-unverified', 'Exact existing optional runtime must be available');
  assert.equal(profile.contract_sha256, golden.profile.contract_sha256);
  const request = { source_id: src.id, source_sha256: src.sha256, series: src.metadata.selected_series,
    context_selection: golden.request.context_selection, output_selection: golden.request.output_selection,
    profile_id: profile.id, profile_contract_sha256: profile.contract_sha256,
    runtime_contract_sha256: createHash('sha256').update(stable(profile.runtime)).digest('hex'),
    weights_sha256: profile.model.sha256, rgb_policy: 'puma-first-three-samples',
    declared_stain: 'hematoxylin-eosin', working_bytes: profile.resources.minimum_working_bytes };
  assert.deepEqual(request.context_selection, { x: 0, y: 0, width: 1024, height: 1024, z: 0, t: 0, c: 0, level: 0 });
  assert.deepEqual(request.output_selection, { x: 960, y: 0, width: 64, height: 64, z: 0, t: 0, c: 0, level: 0 });
  const first = await execute('tissue_model_preview', request); assert.match(first.preview_hash, /^[a-f0-9]{64}$/u);
  const reference = (await nativeTask('tissue_model_run', { preview_id: first.preview_id, preview_hash: first.preview_hash })).result;
  const second = await execute('tissue_model_preview', request); assert.notEqual(second.preview_id, first.preview_id);
  const prepared = (await execute('workflow_graph_prepared_previews', { source_id: src.id })).previews.find(item => item.preview_id === second.preview_id);
  assert.ok(prepared); assert.equal(prepared.preview_hash, second.preview_hash);
  const comparison = reportNode({ node: 'a_tissue', port: 'result' }, { input: 'reference' });
  comparison.settings = { ...comparison.settings, semantics: 'foreground-region', iou_thresholds: [], working_bytes: request.working_bytes,
    reference_declaration: 'Repeated packaged inference deterministic regression against retained same-input execution; not manual ground truth or independent accuracy' };
  const definition = { schema: 'loci.workflow/v2', name: 'Actual prepared tissue and retained regression report',
    inputs: { prepared: 'tissue-preview', reference: 'label-result' }, nodes: [
      { id: 'a_tissue', operation: 'tissue_model_run', contract_version: 1, inputs: { preview: { input: 'prepared' } }, settings: {} }, comparison],
    outputs: { candidate: { node: 'a_tissue', port: 'result' }, report: { node: 'b_agreement', port: 'result' } }, working_bytes: request.working_bytes };
  const saved = await saveDefinition(definition);
  const panel = await openGraph(saved.id, { prepared: `${prepared.preview_id}:${prepared.preview_hash}`, reference: `${reference.id}:${reference.revision_hash}` }, src.id);
  const before = new Set((await graphRuns()).map(item => item.id));
  await panel.getByRole('button', { name: 'Run composed workflow', exact: true }).click();
  let run = await wait(async () => (await graphRuns()).find(item => !before.has(item.id)), item => item?.data.nodes.a_tissue.state === 'succeeded', 'actual graph tissue adoption', 180000);
  assert.equal(run.data.nodes.b_agreement.state, 'pending');
  await panel.getByRole('button', { name: 'Advance workflow', exact: true }).click();
  run = await wait(() => graphById(run.id), item => item.data.state === 'succeeded', 'actual tissue graph report', 180000);
  const all = await snapshot(), candidate = all.results.find(item => item.id === run.data.outputs.candidate.result_id);
  const report = all.results.find(item => item.id === run.data.outputs.report.result_id); assert.ok(candidate && report);
  const metrics = await execute('annotation_evaluation_get', { ...bound(report), table: 'summary' });
  assert.equal(metrics.annotation_evaluation.metrics.region.iou, 1); assert.equal(metrics.annotation_evaluation.metrics.region.dice, 1);
  record.oracle = await oracle('tissue', { study, result: candidate, classes: values.reference_classes.path, probabilities: values.reference_probabilities.path });
  const count = (await snapshot()).jobs.length;
  await assert.rejects(() => execute('morphometrics_run', { ...bound(candidate), working_bytes: 64 * 1024**2 }), /underlying|parent|derived|label/iu);
  const afterRefusal = await snapshot(); assert.deepEqual(afterRefusal.results, all.results);
  const refusalJobs = afterRefusal.jobs.filter(item => !all.jobs.some(prior => prior.id === item.id));
  assert.ok(refusalJobs.length <= 1);
  for (const job of refusalJobs) { assert.equal(job.operation, 'morphometrics_run'); assert.equal(job.state, 'failed'); assert.deepEqual(job.result_ids, []); }
  record.morphology_refusal = { preserved: true, jobs_before: count, jobs_after: afterRefusal.jobs.length };
  record.run = run; record.candidate = candidate; record.reference = reference; record.report = report;
  record.status = 'passed'; await shot('05-actual-prepared-tissue-graph');
  pickers.source = source; await installPickers();
}

try {
  receipt.harness_sha256 = await sha(import.meta.filename); receipt.build = await identity();
  assert.equal(receipt.build.manifest.sourceRevision, env.LOCI_QA_SOURCE_COMMIT); assert.equal(receipt.build.manifest.sourceDirty, false);
  const fixture = await oracle('setup', { source }); receipt.fixture = fixture;
  await launch(); await createEmptyStudy(page);
  await page.getByRole('button', { name: 'Add images…', exact: true }).filter({ visible: true }).first().waitFor();
  await fileMenuAction(page, 'Add images…');
  const initial = await wait(snapshot, value => value?.sources.length === 1, 'synthetic native source import');
  const src = initial.sources[0]; assert.equal(src.sha256, fixture.source_sha256);
  const selection = { x: 0, y: 0, width: 32, height: 32, z: 0, t: 0, c: 0, level: 0 };
  const recipe = { segmentation: { method: 'components', threshold: 50 }, measurement_channels: [0], working_bytes: 64 * 1024**2 };
  const seed = (await nativeTask('run_recipe', { source_id: src.id, selection, recipe })).result; assert.equal(seed.object_count, 2);
  let annotations = await execute('source_annotations', { source_id: src.id });
  for (const [x, y, width, height] of [[4, 4, 8, 8], [20, 20, 8, 4]]) annotations = await execute('annotate_source', {
    source_id: src.id, source_sha256: src.sha256, expected_revision: annotations.revision, action: 'add',
    annotation: { kind: 'rectangle', points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
      label: 'Authored exact technical object', color: '#aabbcc', z: 0, t: 0 } });
  const candidates = await execute('annotation_reference_candidates', { ...bound(seed), offset: 0, limit: 100 }); assert.equal(candidates.total, 2);
  const reference = (await nativeTask('annotation_reference_run', { ...bound(seed), source_annotations_revision: annotations.revision,
    annotation_ids: candidates.candidates.map(item => item.id), semantics: 'instances',
    coverage_declaration: 'Complete authored32x32crop; independent rectangles64and32pixels', working_bytes: 64 * 1024**2 })).result;
  assert.equal(reference.kind, 'annotation-reference');
  const definition = { schema: 'loci.workflow/v2', name: 'Renderer exact recipe and authored reference',
    inputs: { image: 'source-selection', reference: 'label-result' }, nodes: [
      { id: 'a_segment', operation: 'run_recipe', contract_version: 1, inputs: { source: { input: 'image' } }, settings: { recipe } },
      reportNode({ node: 'a_segment', port: 'result' }, { input: 'reference' })],
    outputs: { report: { node: 'b_agreement', port: 'result' } }, working_bytes: 64 * 1024**2 };
  const saved = await saveDefinition(definition); await page.locator(`button[data-source-id="${src.id}"]`).click();
  const panel = await openGraph(saved.id, { image: src.id, reference: `${reference.id}:${reference.revision_hash}` }, src.id);
  const referenceOptions = await panel.getByLabel('Workflow input reference', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
  assert.ok(referenceOptions.includes(`${seed.id}:${seed.revision_hash}`)); assert.ok(referenceOptions.includes(`${reference.id}:${reference.revision_hash}`));
  await shot('01-explicit-source-and-frozen-reference');
  await panel.getByRole('button', { name: 'Run composed workflow', exact: true }).click();
  const original = await wait(async () => (await graphRuns()).find(item => item.data.workflow_id === saved.id),
    item => item?.data.nodes.a_segment.state === 'succeeded', 'first native graph step');
  assert.equal(original.data.nodes.b_agreement.state, 'pending'); assert.equal(original.data.state, 'running');
  await panel.locator('.composed-run-nodes li').filter({ hasText: 'a_segment' }).getByText('succeeded', { exact: true }).waitFor();
  await wait(() => panel.getByRole('button', { name: 'Advance workflow', exact: true }).isEnabled(), Boolean, 'renderer first step settled');
  await panel.getByRole('button', { name: 'Cancel composed run', exact: true }).click();
  const stopped = await wait(() => graphById(original.id), item => item.data.state === 'cancelled', 'deliberate partial graph stop');
  const jobIdsBefore = (await snapshot()).jobs.map(item => item.id);
  await panel.getByRole('button', { name: 'Inspect continuation', exact: true }).click();
  await panel.getByText('1 completed step retained · 1 remaining', { exact: true }).waitFor();
  const proof = (await execute('workflow_graph_continuation', { run_id: stopped.id })).continuation;
  assert.equal(proof.can_start_fresh, true); assert.deepEqual(proof.uncompleted_nodes, ['b_agreement']);
  assert.deepEqual(proof.proposal.bindings.reused_0, stopped.data.nodes.a_segment.output);
  await shot('02-exact-continuation-proof');
  await panel.getByRole('button', { name: 'Prepare fresh run', exact: true }).click();
  const fresh = await wait(async () => (await graphRuns()).find(item => item.data.continuation?.run_id === stopped.id), Boolean, 'fresh native continuation');
  assert.equal(fresh.data.state, 'prepared'); assert.equal(fresh.data.owner, null); assert.notEqual(fresh.id, stopped.id);
  assert.deepEqual(fresh.data.continuation, proof); assert.deepEqual(Object.keys(fresh.data.nodes), ['b_agreement']);
  assert.deepEqual((await snapshot()).jobs.map(item => item.id), jobIdsBefore, 'Preparing never dispatches a node');
  assert.deepEqual(await graphById(stopped.id), stopped, 'Original run is immutable across handoff');
  assert.deepEqual(fresh.data.plan.bindings.reused_0, stopped.data.nodes.a_segment.output);
  await panel.getByText('Fresh continuation prepared. Advance workflow when you are ready; no step has started.', { exact: true }).waitFor();
  await shot('03-fresh-prepared-run-no-dispatch');
  await panel.getByRole('button', { name: 'Advance workflow', exact: true }).click();
  const completed = await wait(() => graphById(fresh.id), item => item.data.state === 'succeeded', 'continued native annotation report');
  const state = await snapshot(), prediction = state.results.find(item => item.id === stopped.data.nodes.a_segment.output.result_id);
  const report = state.results.find(item => item.id === completed.data.outputs.report.result_id); assert.ok(prediction && report);
  assert.equal(report.kind, 'annotation-agreement'); assert.equal(state.jobs.length, 4);
  const metrics = await execute('annotation_evaluation_get', { ...bound(report), table: 'summary' });
  assert.equal(metrics.annotation_evaluation.metrics.region.iou, 1); assert.equal(metrics.annotation_evaluation.metrics.region.dice, 1);
  assert.deepEqual(metrics.annotation_evaluation.metrics.instances.scores.map(item => item.f1), [1, 1]);
  const rows = (await inspected(prediction)).measurements;
  assert.deepEqual(rows.map(item => item.measure), [64, 32]);
  assert.deepEqual(rows.map(item => Object.values(item.intensity)[0].mean), [100, 200]);
  assert.ok(state.results.every(item => !item.review || item.review.disposition !== 'reviewed'));
  receipt.synthetic_oracle = await oracle('synthetic', { study, results: { prediction, reference, report } });
  await panel.getByLabel('Reusable workflow name', { exact: true }).fill('Captured exact continued analysis');
  await panel.getByRole('button', { name: 'Save as workflow', exact: true }).click();
  const captured = await wait(async () => (await execute('workflow_graph_list')).workflows.find(item => item.data.definition.name === 'Captured exact continued analysis'), Boolean, 'successful renderer definition capture');
  assert.deepEqual(captured.data.definition, { ...completed.data.plan.definition, name: 'Captured exact continued analysis' });
  assert.equal((await snapshot()).jobs.length, 4); await shot('04-successful-definition-capture');
  receipt.synthetic = { source: src, seed, reference, prediction, report, original: stopped, continued: completed, captured, metrics, report_record: await inspected(report) };
  receipt.checks.push('actual-renderer-source-and-reference-bindings', 'deterministic-partial-stop', 'native-explicit-fresh-continuation-no-auto-dispatch',
    'exact-successful-output-reuse-without-rerun', 'source-pixel-and-instance-oracle', 'renderer-successful-definition-capture');
  await optionalTissue();
  await api('exportStudy'); receipt.portable_sha256 = await sha(portable);
  const beforeImport = await snapshot(), beforeGraphs = await graphRuns(), beforeDefinitions = (await execute('workflow_graph_list')).workflows;
  const imported = await api('importStudy'); assert.equal(imported.project.project_id, beforeImport.project.project_id);
  for (const importedSource of imported.sources) {
    pickers.source = importedSource.id === src.id ? source : path.join(output, 'TRAINING004.tif');
    await installPickers(); await api('relinkSource', [importedSource.id, 'file']);
  }
  assert.deepEqual(await graphRuns(), beforeGraphs); assert.deepEqual((await execute('workflow_graph_list')).workflows, beforeDefinitions);
  const afterImport = await snapshot(); assert.deepEqual(afterImport.results, beforeImport.results);
  assert.deepEqual(afterImport.jobs.map(item => ({ id: item.id, operation: item.operation, result_ids: item.result_ids })),
    beforeImport.jobs.map(item => ({ id: item.id, operation: item.operation, result_ids: item.result_ids })));
  pickers.openStudy = restored; await installPickers();
  receipt.retained_before_cold = { graphs: beforeGraphs, definitions: beforeDefinitions, results: afterImport.results, jobs: afterImport.jobs };
  await close(); await launch(); await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await wait(snapshot, value => value?.results.length === beforeImport.results.length, 'fresh-profile portable study reopen');
  assert.deepEqual(await graphRuns(), beforeGraphs); assert.deepEqual((await execute('workflow_graph_list')).workflows, beforeDefinitions);
  const cold = await snapshot(); assert.deepEqual(cold.results, afterImport.results); assert.deepEqual(cold.jobs, afterImport.jobs);
  assert.deepEqual((await inspected(report)).provenance, receipt.synthetic.report_record.provenance);
  receipt.cold_oracle = await oracle('synthetic', { study: restored, results: { prediction, reference, report } });
  if (receipt.optional_tissue.status === 'passed') receipt.optional_tissue.cold_oracle = await oracle('tissue', { study: restored,
    result: receipt.optional_tissue.candidate, classes: receipt.optional_tissue.inputs.reference_classes.path,
    probabilities: receipt.optional_tissue.inputs.reference_probabilities.path });
  await selectWorkbenchTool(page, 'Workflow');
  const retainedDisclosure = page.locator('details.composed-workflows');
  if (!await retainedDisclosure.evaluate(element => element.open)) await retainedDisclosure.locator('summary').click();
  await page.getByRole('region', { name: 'Composed workflows', exact: true }).waitFor();
  await shot('06-cold-portable-history');
  receipt.checks.push('actual-native-portable-export-import-and-explicit-source-relink', 'fresh-process-profile-reopen-exact-results-graphs-and-jobs', 'cold-array-hash-and-value-oracles');
  assert.equal(await sha(source), fixture.source_sha256, 'Original authored source changed');
  assert.deepEqual(await identity(), receipt.build); assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(receipt.network_requests, []);
  assert.equal(receipt.process_tracking_error, undefined); receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  if (page) { await shot('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  try { await close(); } catch (error) { receipt.status = 'failed'; receipt.cleanup_error = { message: error.message, stack: error.stack }; failure ??= error; }
  receipt.finished_at = new Date().toISOString(); await writeJson(path.join(output, 'receipt.json'), receipt);
  console.log(JSON.stringify({ status: receipt.status, output, checks: receipt.checks.length }));
}
if (failure) throw failure;
