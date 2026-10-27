/** Synthetic packaged shared researcher/agent journey using actual MCP SDK stdio.
 * cd desktop; LOCI_PACKAGED_APP=/.../Loci.app LOCI_QA_PYTHON=/.../python
 * LOCI_QA_SOURCE_COMMIT=<clean packaged SHA> node tests/shared-researcher-agent.qa.mjs
 * Optional LOCI_QA_INTERRUPT_STRESS=1 authors 2048px sources for actual in-flight
 * cancellation. Real approval TTL runs independently with the helper's
 * approval-expiry mode; this foreground journey never changes clocks or DB state.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool, setSelectionField, waitForSnapshot } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile);
const bundle = process.env.LOCI_PACKAGED_APP && path.resolve(process.env.LOCI_PACKAGED_APP);
const python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin', 'Supported packaged macOS journey only');
assert.ok(bundle && python && path.isAbsolute(python), 'Set LOCI_PACKAGED_APP and absolute LOCI_QA_PYTHON');
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'Pin LOCI_QA_SOURCE_COMMIT');
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? '../.loci/evidence/qa/shared-researcher-agent');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'run-'));
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const executable = path.join(bundle, 'Contents/MacOS/Loci');
const helper = path.resolve(import.meta.dirname, '../../scripts/qa/shared-researcher-agent-client.py');
const study = path.join(output, 'synthetic.loci-study');
const access = path.join(output, 'access');
const exports = path.join(output, 'exports');
const stress = process.env.LOCI_QA_INTERRUPT_STRESS === '1';
const hash = async file => { const h = createHash('sha256'); for await (const block of createReadStream(file)) h.update(block); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = async () => ({ executable: await hash(executable), asar: await hash(path.join(bundle, 'Contents/Resources/app.asar')), worker: await hash(worker) });
const cli = async (...args) => JSON.parse((await exec(worker, ['--loci', '--json', ...args], { timeout: 120000, maxBuffer: 16 * 1024 ** 2 })).stdout);
const operation = (name, request) => cli('execute', '--project', study, name, '--request', JSON.stringify(request));
const snapshot = () => cli('snapshot', '--project', study);
const receipt = { schema: 'loci.shared-researcher-agent-packaged-qa/v1', status: 'running', started_at: new Date().toISOString(), source_commit: sourceCommit,
  interaction: 'Playwright Electron controls and actual MCP SDK; native picker substitution', scientific_scope: 'Generated known-grid sources only; no biological validation',
  not_exercised: ['Ordinary manual GUI review', 'Model execution/provisioning', 'Real approval TTL (separate approval-expiry command)', ...(stress ? [] : ['In-flight cancellation (set LOCI_QA_INTERRUPT_STRESS=1)']), 'Concurrent live other-policy job cancellation'],
  checks: [], calls: [], screenshots: [], clients: [], renderer_errors: [], output, study };
let app, page, client;
const clients = [];
const save = async () => fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
const sdk = (policy, name) => {
  const child = spawn(python, [helper, 'serve', worker, policy, '--client-name', name], { stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, failure = null, stderr = '', closing = false, crashExpected = false;
  const pending = new Map();
  const info = { name, calls: 0 }; receipt.clients.push(info);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  const timer = setTimeout(() => reject(new Error('SDK transport initialization deadline')), 30000);
  function reject(error) { failure = error; clearTimeout(timer); readyReject(error); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  child.on('error', reject); child.stderr.on('data', value => { stderr += value; });
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch (error) { reject(error); return; }
    if (value.event === 'transport_ready') { clearTimeout(timer); info.transport = value; readyResolve(value); return; }
    const p = pending.get(value.id); if (!p) { reject(new Error(`Unexpected SDK response ${line}`)); return; }
    pending.delete(value.id); clearTimeout(p.timer);
    if (value.controller_error) p.reject(new Error(`${value.controller_error}: ${value.message}`)); else p.resolve(value);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    info.exit = { code, signal, intentional_crash: crashExpected };
    if (!closing && !crashExpected || pending.size) reject(new Error(`SDK controller exited ${code ?? signal}: ${stderr}`)); resolve(info.exit);
  }));
  function command(request) {
    if (failure) return Promise.reject(failure);
    const id = ++next;
    const response = new Promise((resolve, rejectCall) => {
      const timeout = setTimeout(() => { pending.delete(id); rejectCall(new Error(`SDK request ${id} deadline`)); }, 45000);
      pending.set(id, { resolve, reject: rejectCall, timer: timeout }); child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    }); response.catch(() => {}); return response;
  }
  const controller = { ready, command, expectCrash() { crashExpected = true; },
    async call(name, args, expectedError = false) {
      const response = await command({ action: 'call', name, arguments: args }); info.calls++; controller.lastResponse = response;
      receipt.calls.push({ client: info.name, tool: name, expected_error: expectedError, is_error: response.is_error,
        operation: args.operation ?? null, targets: args.job_id ?? args.result_id ?? args.request?.source_id ?? null });
      assert.equal(response.is_error, expectedError, `${name}: ${JSON.stringify(response)}`); return response.structured_content;
    },
    async close() {
      if (closing) return; closing = true; clearTimeout(timer);
      if (!crashExpected && child.exitCode === null && !failure) await command({ action: 'close' });
      child.stdin.end();
      let deadline;
      try { const exit = await Promise.race([exited, new Promise((_, rejectClose) => { deadline = setTimeout(() => { child.kill(); rejectClose(new Error('Owned SDK controller cleanup deadline')); }, 10000); })]); if (!crashExpected) assert.equal(exit.code, 0); }
      finally { clearTimeout(deadline); await fs.writeFile(path.join(output, `sdk-${receipt.clients.indexOf(info) + 1}.log`), stderr); }
    } };
  clients.push(controller); return controller;
};
const inspect = (operation, request = {}) => client.call('inspect_action', { operation, request });
const submit = async (operation, request, key) => (await client.call('submit_action', { operation, request, request_key: key })).job;
async function retainedPreview(jobId) {
  const value = await inspect('task_preview_get', { job_id: jobId });
  const response = client.lastResponse;
  const transport = value.image_transport;
  assert.equal(transport.schema, 'loci.mcp-preview-images/v1');
  assert.equal(transport.output_sha256_scope, 'original-canonical-output-including-image-data-urls');
  assert.deepEqual(transport.images.map(item => item.json_pointer), ['/preview/output/image', '/preview/output/label_image']);
  const images = response.content.filter(item => item.type === 'image'); assert.equal(images.length, 2);
  for (const mapping of transport.images) {
    const block = response.content[mapping.content_index]; assert.equal(block.type, 'image'); assert.equal(block.mimeType, 'image/png'); assert.ok(block.size_bytes > 0); assert.equal(block.sha256, mapping.sha256);
  }
  assert.doesNotMatch(JSON.stringify(value), /data:image|base64/);
  (receipt.preview_transports ??= []).push({ job_id: jobId, output_sha256: value.preview.output_sha256, image_transport: transport, images });
  return value.preview;
}
async function expandPreviewIdentity(pane, jobId, outputHash) {
  const details = pane.locator('details'); if (!(await details.evaluate(element => element.open))) await details.locator(':scope > summary').click();
  await pane.getByText(jobId, { exact: true }).waitFor(); await pane.getByText(outputHash, { exact: true }).waitFor();
}

const drawer = () => page.getByRole('region', { name: 'Agent session and approvals', exact: true });
async function openDrawer() { const trigger = page.getByRole('button', { name: 'Agent session status', exact: true }); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click(); await drawer().waitFor(); }
async function closeDrawer() { if (await drawer().count()) await drawer().getByRole('button', { name: 'Close agent session drawer', exact: true }).click(); }
async function waitJob(id, expected = 'succeeded') {
  const end = Date.now() + 120000; let job;
  while (Date.now() < end) { job = (await client.call('job_status', { job_id: id })).job; if (!['queued', 'running'].includes(job.state) && !job.owned_worker_active) { assert.equal(job.state, expected, JSON.stringify(job)); return job; } await delay(100); }
  throw new Error(`Job deadline: ${JSON.stringify(job)}`);
}
async function shot(name) { await page.screenshot({ path: path.join(output, name + '.png') }); receipt.screenshots.push(name + '.png'); await save(); }
async function launch(profile) {
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(output, profile)}`], timeout: 120000 });
  page = await app.firstWindow(); page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  await app.evaluate(({ dialog, BrowserWindow }, target) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }, study);
  if (process.env.LOCI_QA_BACKGROUND === '1') await app.evaluate(({ app, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); } app.hide(); });
  await page.getByRole('button', { name: 'Open study', exact: true }).click(); await page.getByRole('main', { name: 'Research workspace', exact: true }).waitFor();
}
const measurements = rows => rows.map(row => ({ label: row.label, voxel_count: row.voxel_count, measure: row.measure, mean: Object.values(row.intensity)[0].mean }));
async function oracle(resultId, variant, corrected = false) {
  const args = [helper, 'verify-result', study, resultId, String(variant), ...(corrected ? ['--corrected'] : [])];
  const value = JSON.parse((await exec(python, args, { timeout: 30000, maxBuffer: 2 * 1024 ** 2 })).stdout); assert.equal(value.verified, true); receipt.checks.push({ name: 'independent-array-and-raw-measurement-oracle', ...value }); return value;
}
try {
  receipt.build = await identity(); receipt.script_sha256 = await hash(import.meta.filename); receipt.helper_sha256 = await hash(helper);
  receipt.sdk_helper_sha256 = await hash(path.join(path.dirname(helper), 'agent-session-client.py'));
  const build = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(build.sourceRevision, sourceCommit); assert.equal(build.sourceDirty, false);
  const fixture = JSON.parse((await exec(python, [helper, 'fixture', output, '--size', stress ? '2048' : '64'], { timeout: 30000 })).stdout); receipt.fixture = fixture;
  await cli('create', '--project', study, '--title', 'Shared synthetic workflow');
  const sources = [];
  for (const item of fixture.sources) {
    const imported = await cli('import', '--project', study, item.path); const source = imported.sources.find(source => source.sha256 === item.sha256); assert.ok(source); sources.push(source);
    await operation('sample', { id: source.id, expected_revision: 0, data: { study: 'Shared synthetic workflow', sample: `Synthetic ${item.variant + 1}`, condition: 'A', biological_replicate: `R${item.variant + 1}`, plate: null, well: null } });
  }
  const recipe = { segmentation: { method: 'components', threshold: 50, min_size: 1 }, measurement_channels: [0] };
  const humanRequestFile = path.join(output, 'human-request.json'); await fs.writeFile(humanRequestFile, JSON.stringify({ source_id: sources[0].id, selection: fixture.selection, recipe }));
  const humanQueued = (await cli('submit', '--project', study, '--request', `@${humanRequestFile}`, '--request-key', 'preserved-human-queued')).job;
  await launch('user-data'); await page.locator('.research-sources-list button').filter({ hasText: sources[0].name }).click();
  await selectWorkbenchTool(page, 'Display'); for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) await setSelectionField(page, label, fixture.selection[key]);
  await selectWorkbenchTool(page, 'Analyze'); await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical'); await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  await page.getByLabel('Threshold', { exact: true }).fill('50'); await page.getByLabel('Minimum object measure', { exact: true }).fill('1'); await page.getByLabel('Minimum object measure', { exact: true }).press('Tab');
  await selectWorkbenchTool(page, 'Workflow'); const workflow = page.getByRole('region', { name: 'Visual workflow builder', exact: true });
  await workflow.getByLabel('Workflow name', { exact: true }).fill('Shared synthetic components'); await workflow.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workflow-save-state')?.textContent === 'Saved revision 1');
  const saved = (await operation('workflow_list', {})).workflows.find(item => item.data.definition.name === 'Shared synthetic components'); assert.ok(saved);
  await workflow.getByRole('button', { name: 'Select Measure raw pixels', exact: true }).click(); await workflow.getByRole('button', { name: 'Preview through this step', exact: true }).click(); await workflow.getByText(/Preview through measure/).waitFor();
  await workflow.getByRole('button', { name: 'Run workflow', exact: true }).click(); await workflow.getByText(/objects · waiting review/).waitFor({ timeout: 120000 });
  const guiState = await page.evaluate(() => window.lociResearch.getSnapshot()); const guiJob = [...guiState.jobs].reverse().find(item => item.operation === 'workflow_run' && item.request.task_request.workflow_id === saved.id); assert.equal(guiJob.state, 'succeeded');
  const guiResult = (await operation('workflow_status', { run_id: guiJob.id })).run.data; await oracle(guiResult.result_id, 0);
  const binding = source => ({ workflow_id: saved.id, workflow_revision: saved.revision, definition_sha256: saved.data.definition_sha256, source_id: source.id, source_sha256: source.sha256, selection: fixture.selection });
  const batch = workflow.locator('details.workflow-batch'); if (!(await batch.evaluate(element => element.open))) await batch.locator(':scope > summary').click();
  for (const source of sources) await batch.getByLabel(source.name, { exact: true }).check();
  const beforeBatch = new Set((await snapshot()).jobs.map(item => item.id));
  await batch.getByRole('button', { name: 'Check and run batch', exact: true }).click();
  await workflow.getByText('Batch requests retained. Follow Jobs for exact status and recovery.', { exact: true }).waitFor({ timeout: 120000 });
  const batchState = await waitForSnapshot(page, value => { const added = value.jobs.filter(item => !beforeBatch.has(item.id)); return added.length === 2 && added.every(item => item.state === 'succeeded'); }, 'two selected GUI workflow sources', 120000);
  const batchJobs = batchState.jobs.filter(item => !beforeBatch.has(item.id));
  assert.deepEqual(batchJobs.map(item => item.request.task_request.source_id).sort(), sources.map(item => item.id).sort());
  for (const item of batchJobs) { assert.equal(item.result_ids.length, 1); await oracle(item.result_ids[0], sources.findIndex(source => source.id === item.request.task_request.source_id)); }
  for (const [variant, source] of sources.entries()) {
    const cliRequestFile = path.join(output, `cli-workflow-${variant}.json`); await fs.writeFile(cliRequestFile, JSON.stringify(binding(source)));
    const direct = await cli('submit', '--project', study, '--operation', 'workflow_run', '--request', `@${cliRequestFile}`, '--request-key', `cli-workflow-${variant}`, '--run'); await oracle(direct.result.id, variant);
  }
  receipt.checks.push('Actual workflow UI author/save/preview, selected two-source GUI batch and frozen CLI match independent known arrays'); await shot('01-human-workflow');
  await page.locator('.research-sources-list button').filter({ hasText: sources[0].name }).click();
  await selectWorkbenchTool(page, 'Agent'); const panel = page.locator('.research-agent'); await panel.getByLabel('Assistant access level', { exact: true }).selectOption('full'); await panel.getByLabel('Session permission mode', { exact: true }).selectOption('ask_approval');
  const custom = panel.locator('details.research-agent-custom'); if (!(await custom.evaluate(element => element.open))) await custom.locator(':scope > summary').click();
  await panel.getByLabel('Agent memory MiB', { exact: true }).fill('1024'); await panel.getByLabel('Agent CPU seconds', { exact: true }).fill('120');
  await panel.getByRole('button', { name: 'Validate exact scope and recipe', exact: true }).click(); await panel.getByLabel('Exact recipe validation', { exact: true }).waitFor(); await fs.mkdir(exports);
  await app.evaluate(({ dialog }, targets) => { dialog.showOpenDialog = async options => { if (options.title !== 'Choose the permitted agent export folder') throw new Error('Unexpected picker'); return { canceled: false, filePaths: [targets.exports] }; }; dialog.showSaveDialog = async options => { if (options.title !== 'Create private MCP access bundle') throw new Error('Unexpected picker'); return { canceled: false, filePath: targets.access }; }; }, { exports, access });
  await panel.getByRole('button', { name: `Grant selected access to ${sources[0].name}`, exact: true }).click(); await panel.getByLabel('Created agent access receipt', { exact: true }).waitFor();
  const policyPath = path.join(access, 'agent-policy.json'); const policy = await json(policyPath); assert.equal(policy.schema, 'loci.agent-policy/v5'); assert.equal(policy.sources.length, 2); receipt.policy_sha256 = await hash(policyPath);
  client = sdk(policyPath, 'Loci shared workflow QA 1'); await client.ready; await client.command({ action: 'initialize' });
  const connected = await waitForSnapshot(page, value => value.agent_sessions.sessions.some(item => item.client_id === 'Loci shared workflow QA 1'), 'real shared SDK session'); const firstSession = connected.agent_sessions.sessions.find(item => item.client_id === 'Loci shared workflow QA 1');
  assert.ok((await inspect('workflow_list')).workflows.some(item => item.id === saved.id)); assert.equal((await inspect('workflow_get', { workflow_id: saved.id })).workflow.data.definition_sha256, saved.data.definition_sha256);
  const guide = await client.call('action_guide', {}); assert.equal(guide.actions.find(item => item.operation === 'workflow_preview').execution_kind, 'preview-task');
  for (const source of sources) assert.equal((await inspect('workflow_preflight', binding(source))).source_sha256, source.sha256);
  const previewRequest = { ...binding(sources[0]), target_node_id: 'measure' };
  const pending = submit('workflow_preview', previewRequest, 'approved-shared-preview'); pending.catch(() => {});
  const awaiting = await waitForSnapshot(page, value => value.agent_sessions.approvals.some(item => item.state === 'pending' && item.operation === 'submit_action'), 'exact preview approval'); const approval = awaiting.agent_sessions.approvals.find(item => item.state === 'pending' && item.operation === 'submit_action');
  assert.equal(approval.session_id, firstSession.session_id); await openDrawer(); await drawer().getByRole('button', { name: 'Approve submit_action', exact: true }).click();
  const approvedPreviewJob = await pending; await waitJob(approvedPreviewJob.id); const preview = await retainedPreview(approvedPreviewJob.id);
  assert.equal(preview.adopted, false); assert.deepEqual(measurements(preview.output.measurements), fixture.expected[0]);
  await drawer().getByLabel('Agent permission mode', { exact: true }).selectOption('full_access'); await closeDrawer();
  await openDrawer(); await drawer().getByRole('button', { name: `Inspect preview ${approvedPreviewJob.id}`, exact: true }).first().click();
  const comparison = page.getByRole('region', { name: 'Agent preview comparison', exact: true }); await comparison.waitFor(); await closeDrawer(); await expandPreviewIdentity(comparison.getByRole('region', { name: 'Current preview', exact: true }), approvedPreviewJob.id, preview.output_sha256); await comparison.getByRole('button', { name: 'Pin current preview', exact: true }).click();
  const mcpResults = [];
  for (const [variant, source] of sources.entries()) {
    const previewJob = await submit('workflow_preview', { ...binding(source), target_node_id: 'measure' }, `preview-source-${variant}`); await waitJob(previewJob.id); const cached = await retainedPreview(previewJob.id); assert.deepEqual(measurements(cached.output.measurements), fixture.expected[variant]);
    if (variant === 0) {
      assert.notEqual(previewJob.id, approvedPreviewJob.id); await openDrawer(); await drawer().getByRole('button', { name: `Inspect preview ${previewJob.id}`, exact: true }).first().click(); await closeDrawer();
      const pinned = comparison.getByRole('region', { name: 'Pinned reference', exact: true }); const current = comparison.getByRole('region', { name: 'Current preview', exact: true });
      await pinned.waitFor(); await current.waitFor(); await expandPreviewIdentity(pinned, approvedPreviewJob.id, preview.output_sha256); await expandPreviewIdentity(current, previewJob.id, cached.output_sha256);
      assert.equal(await comparison.locator('img').count(), 4); await comparison.locator('img').evaluateAll(async images => { for (const image of images) { await image.decode(); if (!image.naturalWidth || !image.naturalHeight) throw new Error('Recorded preview image failed to decode'); } });
      await shot('02-pinned-actual-agent-previews'); await comparison.getByRole('button', { name: 'Close preview comparison', exact: true }).click(); receipt.checks.push('Actual same-source pinned and current previews retain distinct job identities, decoded source/label images and original output digests');
    }
    const job = await submit('workflow_run', binding(source), `run-source-${variant}`); const complete = await waitJob(job.id); assert.equal(complete.result_ids.length, 1);
    const status = await inspect('workflow_status', { run_id: job.id }); assert.equal(status.state, 'waiting_review'); const result = (await client.call('result', { result_id: complete.result_ids[0] })).result; mcpResults.push(result); await oracle(result.id, variant);
    assert.equal((await submit('workflow_run', binding(source), `run-source-${variant}`)).id, job.id, 'Stable retry must not duplicate publication');
    await client.call('review_result', { request: { result_id: result.id, revision_hash: result.revision_hash, disposition: 'reviewed', reason: 'Automated known-grid research software QA; no biological assessment', coverage: 'Entire generated crop and all exact object measurements', expected_review_sha256: null } });
  }
  const ids = mcpResults.map(item => item.id); const catalog = await inspect('intensity_catalog', { result_ids: ids }); assert.equal(catalog.results.length, 2);
  const intensityRequest = { result_ids: ids, endpoint: { schema: 'loci.intensity-endpoint/v1', kind: 'raw-channel-intensity', statistic: 'mean', unit: 'source-intensity', compartment: 'object' }, metric_ids: Object.fromEntries(catalog.results.map(item => [item.result_id, item.descriptors[0].id])), declaration: { channel: 'Synthetic raw', acquisition_context: 'Authored exact integer fixtures', rationale: 'Known source values only; no inference of biological comparability' } };
  const intensityPreview = await inspect('intensity_preview', intensityRequest); const report = JSON.parse(intensityPreview.report_json); assert.deepEqual(report.images.map(item => item.mean), [150, 160]); assert.equal(report.conditions[0].mean, 155); assert.ok(Math.abs(report.conditions[0].sd - Math.sqrt(50)) < 1e-12);
  const savedReport = await operation('intensity_save', intensityPreview); assert.equal((await inspect('intensity_get', { report_id: savedReport.report_id })).report.report_hash, report.report_hash); assert.ok((await inspect('intensity_list')).reports.some(item => item.id === savedReport.report_id));
  const summary = await inspect('study_summary', { result_ids: ids }); assert.deepEqual(summary, await operation('study_summary', { result_ids: ids })); assert.ok(Math.abs(summary.summaries[0].mean - 52 / 3) < 1e-12); assert.equal(summary.summaries[0].n_biological_replicates, 2); receipt.study_summary = summary; receipt.intensity_report_hash = report.report_hash;
  const parent = mcpResults[0]; const bound = { result_id: parent.id, revision_hash: parent.revision_hash }; const gate = { kind: 'rectangle', x_metric: 'measure', y_metric: 'voxel_count', bounds: [16, 24, 64, 96] };
  const evaluated = await inspect('population_gate_evaluate', { ...bound, gate }); assert.deepEqual(evaluated.labels, [1, 2]);
  const group = await operation('population_group_save', { ...bound, gate, name: 'Known two objects', membership_sha256: evaluated.membership_sha256 }); assert.ok((await inspect('population_group_list', bound)).groups.some(item => item.id === group.id)); assert.deepEqual((await inspect('population_group_get', { ...bound, group_id: group.id })).membership.labels, [1, 2]);
  const info = await inspect('correction_info', bound); const correction = { ...bound, operations: [{ op: 'delete', label: 1, expected_input_sha256: info.label_sha256 }], working_bytes: 512 * 1024 ** 2 };
  const corrected = await waitJob((await submit('correct_result', correction, 'delete-first-square')).id); const child = (await client.call('result', { result_id: corrected.result_ids[0] })).result; await oracle(child.id, 0, true);
  await client.call('review_result', { request: { result_id: child.id, revision_hash: child.revision_hash, disposition: 'reviewed', reason: 'Automated synthetic deletion oracle passed', coverage: 'Entire generated child label grid; original source preserved', expected_review_sha256: null } });
  await client.call('export_result', { result_id: child.id, revision_hash: child.revision_hash, filename: 'corrected-reviewed' });
  const exported = await json(path.join(exports, 'corrected-reviewed', 'result.json')); assert.equal(exported.result.id, child.id); assert.equal(exported.review.actor, 'agent'); receipt.corrected_result = child; receipt.checks.push('Actual MCP two-source workflows, exact preview cache, population/group, intensity hierarchy, summary, correction and reviewed export');
  await client.call('cancel_job', { job_id: humanQueued.id }, true); const preserved = (await snapshot()).jobs.find(item => item.id === humanQueued.id); assert.equal(preserved.state, 'queued'); assert.equal(preserved.cancel_requested, false);
  if (stress) {
    const definition = structuredClone(saved.data.definition); definition.name = 'Synthetic cancellation stress'; const nodes = [...definition.nodes]; nodes.splice(1, 0, ...Array.from({ length: 32 }, (_, index) => ({ id: `smooth${index}`, type: 'process', settings: { op: 'gaussian', sigma: 2 } }))); definition.nodes = nodes; definition.edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })); definition.working_bytes = 512 * 1024 ** 2;
    const savedStress = (await operation('workflow_save', { workflow_id: 'c'.repeat(32), expected_revision: 0, definition })).workflow;
    const stressBinding = { ...binding(sources[0]), workflow_id: savedStress.id, workflow_revision: savedStress.revision, definition_sha256: savedStress.data.definition_sha256, selection: { ...fixture.selection, x: 0, y: 0, width: fixture.size, height: fixture.size } };
    const before = (await snapshot()).results.length; const running = await submit('workflow_run', stressBinding, 'in-flight-cancel'); let live; const admissionDeadline = Date.now() + 10000; do { live = (await client.call('job_status', { job_id: running.id })).job; if (live.state !== 'queued') break; await delay(50); } while (Date.now() < admissionDeadline); assert.equal(live.state, 'running', 'No in-flight claim unless actual computation is running'); assert.equal(live.owned_worker_active, true);
    await client.call('cancel_job', { job_id: running.id }); const cancelled = await waitJob(running.id, 'cancelled'); assert.deepEqual(cancelled.result_ids, []); const after = await snapshot(); assert.equal(after.results.length, before); assert.equal(after.jobs.find(item => item.id === humanQueued.id).state, 'queued'); receipt.checks.push('Actual running native workflow cancellation publishes no result and preserves the human job');
  }
  const beforeCrash = await snapshot(); client.expectCrash(); const crash = JSON.parse((await exec(python, [helper, 'crash-worker', study, firstSession.session_id, worker, policyPath], { timeout: 30000 })).stdout); assert.equal(crash.crashed, true); await client.close();
  await waitForSnapshot(page, value => value.agent_sessions.sessions.some(item => item.session_id === firstSession.session_id && item.state === 'interrupted'), 'actual lost MCP worker');
  client = sdk(policyPath, 'Loci shared workflow QA 2'); await client.ready; await client.command({ action: 'initialize' }); const reconnected = await waitForSnapshot(page, value => value.agent_sessions.sessions.some(item => item.client_id === 'Loci shared workflow QA 2'), 'actual reconnect'); const secondSession = reconnected.agent_sessions.sessions.find(item => item.client_id === 'Loci shared workflow QA 2'); assert.notEqual(secondSession.session_id, firstSession.session_id);
  assert.equal((await inspect('workflow_get', { workflow_id: saved.id })).workflow.id, saved.id); await client.call('submit_action', { operation: 'workflow_run', request: binding(sources[0]), request_key: 'run-source-0' }, true); const afterReconnect = await snapshot(); assert.equal(afterReconnect.results.length, beforeCrash.results.length); assert.equal(afterReconnect.jobs.length, beforeCrash.jobs.length); receipt.checks.push('Actual idle MCP server SIGKILL, interrupted presence and distinct reconnect reject duplicate-owner retry without publication');
  await client.close(); await app.close(); app = null; await launch('cold-reopen-user-data');
  await page.locator(`.research-sources [data-result-id="${child.id}"]`).click(); await selectWorkbenchTool(page, 'Info'); await page.getByRole('status').filter({ hasText: 'Reviewed by agent' }).waitFor(); await oracle(child.id, 0, true);
  assert.equal((await operation('intensity_get', { report_id: savedReport.report_id })).report.report_hash, report.report_hash); const cold = await snapshot(); assert.equal(cold.jobs.find(item => item.id === humanQueued.id).state, 'queued'); assert.equal(cold.results.length, beforeCrash.results.length); receipt.checks.push('Cold reopen preserves exact corrected arrays, agent review, report snapshot, job histories and immutable source hashes');
  await shot('03-cold-reopen-reviewed-correction'); assert.deepEqual(receipt.renderer_errors, []); assert.deepEqual(await identity(), receipt.build); for (const source of fixture.sources) assert.equal(await hash(source.path), source.sha256); receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error.stack ?? String(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { for (const item of clients) await item.close().catch(error => { receipt.cleanup_error = String(error); }); await app?.close().catch(() => {}); receipt.finished_at = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: receipt.status, output, checks: receipt.checks.length })); }
