/** Synthetic packaged macOS session/control regression, using the actual MCP SDK.
 * From desktop: LOCI_PACKAGED_APP=/.../Loci.app LOCI_QA_PYTHON=/.../.venv/bin/python
 * LOCI_QA_SOURCE_COMMIT=<packaged source SHA> node tests/agent-sessions.qa.mjs
 * Optional: LOCI_QA_OUTPUT_ROOT and LOCI_QA_BACKGROUND=1.
 * This is automated packaged control, not an ordinary native/manual GUI claim.
 * Native picker paths are substituted; no renderer/engine state is injected.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool, setSelectionField, waitForSnapshot } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile);
const appPath = process.env.LOCI_PACKAGED_APP && path.resolve(process.env.LOCI_PACKAGED_APP);
const python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin', 'This journey targets the supported macOS package');
assert.ok(appPath && python && path.isAbsolute(python), 'Set LOCI_PACKAGED_APP and absolute LOCI_QA_PYTHON');
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'Set the exact LOCI_QA_SOURCE_COMMIT');
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? '../.loci/evidence/qa/agent-sessions');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'run-'));
const worker = path.join(appPath, 'Contents/Resources/loci-engine/loci-engine');
const executable = path.join(appPath, 'Contents/MacOS/Loci');
const asar = path.join(appPath, 'Contents/Resources/app.asar');
const buildFile = path.join(appPath, 'Contents/Resources/loci-build-identity.json');
const helper = path.resolve(import.meta.dirname, '../../scripts/qa/agent-session-client.py');
const fixtureHelper = path.resolve(import.meta.dirname, '../../scripts/qa/agent-workbench-client.py');
const navigationHelper = path.join(import.meta.dirname, 'workbench-qa-helpers.mjs');
const study = path.join(output, 'synthetic.loci-study');
const access = path.join(output, 'session-access');
const exports = path.join(output, 'exports');
const profile = path.join(output, 'user-data');
const hash = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const requestHash = (policySha, operation, request) => createHash('sha256').update(canonicalJson({ policy_sha256: policySha, operation, request })).digest('hex');
const packageIdentity = async () => ({ executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker), build_identity_sha256: await hash(buildFile) });
const receipt = {
  schema: 'loci.agent-session-packaged-qa/v1', status: 'running', started_at: new Date().toISOString(),
  interaction: 'automated packaged control via Playwright Electron and actual MCP SDK stdio',
  ordinary_native_gui_review: 'not performed by this harness',
  scientific_scope: 'Generated synthetic fixture only; no biological or clinical accuracy claim',
  app: appPath, source_commit: sourceCommit, study, profile,
  background_window: process.env.LOCI_QA_BACKGROUND === '1',
  picker_substitution: ['Open study', 'Choose the permitted agent export folder', 'Create private MCP access bundle'],
  message_box_substitution: 'Response 0 in this isolated synthetic app; not a human confirmation',
  checks: [], snapshots: [], calls: [], screenshots: [], clients: [],
  not_exercised: ['Approval TTL expiry', 'Abrupt worker crash and heartbeat expiry', 'Stop/revoke of an in-flight owned job', 'Concurrent other-policy job cancellation isolation', 'Ordinary native/manual GUI interaction'],
};
let app, page, client;
const clients = [];
const rendererErrors = [];
const saveReceipt = async () => fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
const cli = async (...args) => {
  const result = await exec(worker, ['--loci', '--json', ...args], { timeout: 30000, maxBuffer: 8 * 1024 ** 2 });
  return JSON.parse(result.stdout);
};
const rawSnapshot = () => cli('snapshot', '--project', study);
async function checkpoint(name) {
  const snapshot = await rawSnapshot();
  const filename = `${String(receipt.snapshots.length + 1).padStart(2, '0')}-${name}.json`;
  await fs.writeFile(path.join(output, filename), JSON.stringify(snapshot, null, 2));
  receipt.snapshots.push({ name, filename, sha256: await hash(path.join(output, filename)) });
  if (page) {
    const screenshot = filename.replace(/\.json$/, '.png');
    await page.screenshot({ path: path.join(output, screenshot) });
    receipt.screenshots.push(screenshot);
  }
  await saveReceipt();
  return snapshot;
}
function sdkClient(policy, name) {
  const child = spawn(python, [helper, 'serve', worker, policy, '--client-name', name], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, failure = null, stderr = '', closing = false;
  const pending = new Map();
  const info = { name, controller_pid: child.pid, transport: null, calls: [] };
  receipt.clients.push(info);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const readyTimer = setTimeout(() => { readyReject(new Error('MCP transport ping exceeded 30 seconds')); child.kill(); }, 30000);
  const rejectPending = error => {
    failure = error; clearTimeout(readyTimer); readyReject(error);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', rejectPending);
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch (error) { rejectPending(error); return; }
    if (message.event === 'transport_ready') {
      clearTimeout(readyTimer); info.transport = message; readyResolve(message); return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) { rejectPending(new Error(`Unexpected controller response: ${line}`)); return; }
    pending.delete(message.id); clearTimeout(waiter.timer);
    info.calls.push(message.id);
    if (message.controller_error) waiter.reject(new Error(`${message.controller_error}: ${message.message}`));
    else waiter.resolve(message);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    info.exit = { code, signal };
    if (!closing || code !== 0) rejectPending(new Error(`MCP controller exited (${code ?? signal}): ${stderr}`));
    else if (pending.size) rejectPending(new Error('MCP controller closed with unresolved commands'));
    resolve(info.exit);
  }));
  const command = request => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP command ${id} exceeded 45 seconds`)); }, 45000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    });
    response.catch(() => {}); // UI assertions may run while this SDK call awaits a decision.
    return response;
  };
  const controller = {
    ready, command,
    call(name, args, expectedError = false) {
      const result = command({ action: 'call', name, arguments: args }).then(response => {
        receipt.calls.push({ client: info.name, name, arguments: args, expected_error: expectedError, ...response });
        assert.equal(response.is_error, expectedError, `${name}: ${JSON.stringify(response)}`);
        return response.structured_content;
      });
      result.catch(() => {});
      return result;
    },
    async close() {
      if (closing) return;
      closing = true;
      try {
        if (child.exitCode === null && !failure) await command({ action: 'close' });
        child.stdin.end();
        let timer;
        try {
          const exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('MCP controller did not close within 10 seconds')); }, 10000); })]);
          assert.equal(exit.code, 0, `MCP controller cleanup: ${stderr}`);
        } finally { clearTimeout(timer); }
      } finally {
        clearTimeout(readyTimer);
        await fs.writeFile(path.join(output, `mcp-${receipt.clients.indexOf(info) + 1}-stderr.log`), stderr);
      }
    },
  };
  clients.push(controller);
  return controller;
}
const drawer = () => page.getByRole('region', { name: 'Agent session and approvals', exact: true });
async function openDrawer() {
  const trigger = page.getByRole('button', { name: 'Agent session status', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await drawer().waitFor();
}
async function closeDrawer() {
  if (await drawer().count()) await drawer().getByRole('button', { name: 'Close agent session drawer', exact: true }).click();
}
const sessions = snapshot => snapshot.agent_sessions;
const sessionById = (snapshot, id) => sessions(snapshot).sessions.find(item => item.session_id === id);
async function waitSession(predicate, name) { return waitForSnapshot(page, snapshot => Boolean(snapshot?.agent_sessions && predicate(snapshot.agent_sessions)), name); }
async function pendingApproval(operation, resultId, revisionHash) {
  const snapshot = await waitSession(state => state.approvals.some(item => item.state === 'pending' && item.operation === operation), `${operation} approval`);
  const candidates = sessions(snapshot).approvals.filter(item => item.state === 'pending' && item.operation === operation);
  assert.equal(candidates.length, 1);
  const approval = candidates[0];
  if (resultId) { assert.equal(approval.result_id, resultId); assert.equal(approval.revision_hash, revisionHash); }
  await openDrawer();
  await drawer().getByLabel(`Pending approval for ${operation}`, { exact: true }).waitFor();
  return approval;
}
async function waitJob(id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = (await client.call('job_status', { job_id: id })).job;
    if (!['queued', 'running'].includes(value.state) && !value.owned_worker_active) {
      assert.equal(value.state, 'succeeded', JSON.stringify(value));
      assert.equal(value.result_ids.length, 1);
      return value;
    }
    await delay(100);
  }
  throw new Error('Synthetic owned job did not finish within 30 seconds');
}
const selectedResult = id => page.locator(`.research-sources [data-result-id="${id}"]`);
async function viewerState(sourceId) {
  const viewer = page.locator(`[data-viewer-source="${sourceId}"]`);
  await viewer.waitFor();
  await page.waitForFunction(id => document.querySelector(`[data-viewer-source="${id}"]`)?.getAttribute('data-prepared') === 'true', sourceId);
  return {
    source_id: await viewer.getAttribute('data-viewer-source'), camera: JSON.parse(await viewer.getAttribute('data-camera')),
    selected_result: await page.locator('.research-sources [data-result-id][aria-pressed="true"]').getAttribute('data-result-id'),
    source_view: await page.evaluate(id => window.lociResearch.execute('source_view', { source_id: id }), sourceId),
    analysis_controls: await page.locator('.analysis-region-settings input').evaluateAll(inputs => inputs.map(input => ({ label: input.getAttribute('aria-label'), value: input.value }))),
  };
}
try {
  receipt.build = await packageIdentity();
  receipt.embedded_build_identity = await json(buildFile);
  assert.equal(receipt.embedded_build_identity.sourceRevision, sourceCommit, 'Package source differs from declared candidate');
  assert.equal(receipt.embedded_build_identity.sourceDirty, false, 'Qualification needs a recorded clean candidate');
  receipt.script_sha256 = await hash(import.meta.filename);
  receipt.helper_sha256 = await hash(helper);
  receipt.fixture_helper_sha256 = await hash(fixtureHelper);
  receipt.navigation_helper_sha256 = await hash(navigationHelper);
  await fs.mkdir(exports);
  const fixture = JSON.parse((await exec(python, [helper, 'fixture', output], { timeout: 30000 })).stdout);
  assert.equal(path.dirname(fixture.source), output);
  assert.equal(await hash(fixture.source), fixture.sha256);
  receipt.fixture = fixture;
  await cli('create', '--project', study, '--title', 'Synthetic agent session regression');
  const source = (await cli('import', '--project', study, fixture.source)).sources[0];
  assert.equal(source.sha256, fixture.sha256);
  const humanRequest = { source_id: source.id, selection: fixture.selection, recipe: { segmentation: { method: 'components', threshold: 50, min_size: 1 }, measurement_channels: [0] } };
  const requestFile = path.join(output, 'human-request.json');
  await fs.writeFile(requestFile, JSON.stringify(humanRequest));
  const humanRun = await cli('submit', '--project', study, '--request', `@${requestFile}`, '--request-key', 'human-baseline', '--run');
  assert.equal(humanRun.job.state, 'succeeded');
  assert.equal(humanRun.job.owner, undefined);
  const humanResult = humanRun.result;
  const humanQueued = (await cli('submit', '--project', study, '--request', `@${requestFile}`, '--request-key', 'human-queued-preservation')).job;
  assert.equal(humanQueued.state, 'queued');
  assert.equal(humanQueued.owner, undefined);
  receipt.fixture_setup = { route: 'supported frozen-worker CLI', source: { id: source.id, sha256: source.sha256 }, human_result: humanResult.id, human_queued_job: humanQueued.id };
  await saveReceipt();
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], timeout: 120000 });
  page = await app.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await app.evaluate(({ dialog, BrowserWindow }, studyPath) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [studyPath] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  if (receipt.background_window) await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace', exact: true }).waitFor();
  await selectWorkbenchTool(page, 'Display');
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) await setSelectionField(page, label, fixture.selection[key]);
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical');
  await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  await page.getByLabel('Threshold', { exact: true }).fill('50');
  await page.getByLabel('Minimum object measure', { exact: true }).fill('1');
  await page.getByLabel('Minimum object measure', { exact: true }).press('Tab');
  await selectWorkbenchTool(page, 'Agent');
  const panel = page.locator('.research-agent');
  await panel.getByLabel('Assistant access level', { exact: true }).selectOption('full');
  await panel.getByLabel('Session permission mode', { exact: true }).selectOption('ask_approval');
  await panel.getByRole('button', { name: 'Validate exact scope and recipe', exact: true }).click();
  await panel.getByLabel('Exact recipe validation', { exact: true }).waitFor();
  await app.evaluate(({ dialog }, targets) => {
    dialog.showOpenDialog = async options => {
      if (options.title !== 'Choose the permitted agent export folder') throw new Error('Unexpected open picker');
      return { canceled: false, filePaths: [targets.exports] };
    };
    dialog.showSaveDialog = async options => {
      if (options.title !== 'Create private MCP access bundle') throw new Error('Unexpected save picker');
      return { canceled: false, filePath: targets.access };
    };
  }, { exports, access });
  await panel.getByRole('button', { name: `Grant selected access to ${source.name}`, exact: true }).click();
  await panel.getByLabel('Created agent access receipt', { exact: true }).waitFor();
  const policyPath = path.join(access, 'agent-policy.json');
  const policy = await json(policyPath);
  assert.equal(policy.schema, 'loci.agent-policy/v5');
  assert.equal(policy.permission_mode, 'ask_approval');
  const policySha = await hash(policyPath);
  const approved = await json(path.join(access, 'approved-request.json'));
  receipt.policy_sha256 = policySha;
  const connection = (await json(path.join(access, 'mcp-config.json'))).mcpServers['loci-research'];
  assert.equal(connection.command, worker);
  assert.deepEqual(connection.args, ['--cli', 'mcp', '--policy', policyPath]);
  receipt.mcp_config_sha256 = await hash(path.join(access, 'mcp-config.json'));
  const bundleReady = await waitSession(state => state.status === 'configuration_ready' && state.connected_count === 0, 'bundle ready without connection');
  assert.equal(sessions(bundleReady).sessions.length, 0);
  await page.getByRole('button', { name: 'Agent session status' }).getByText('Agent bundle ready · Not connected', { exact: true }).waitFor();
  await checkpoint('bundle-ready-not-connected');
  client = sdkClient(policyPath, 'Loci packaged session QA 1');
  assert.equal((await client.ready).initialized, false);
  assert.equal((await rawSnapshot()).agent_sessions.connected_count, 0);
  await checkpoint('transport-ping-before-initialize');
  await client.command({ action: 'initialize' });
  const connected = await waitSession(state => state.connected_count > 0 && state.sessions.some(item => item.client_id === 'Loci packaged session QA 1'), 'actual initialized client');
  const firstSession = sessions(connected).sessions.find(item => item.client_id === 'Loci packaged session QA 1');
  assert.equal(firstSession.policy_sha256, policySha);
  await openDrawer();
  await drawer().getByText('Loci packaged session QA 1 1.0', { exact: true }).waitFor();
  receipt.first_session_id = firstSession.session_id;
  receipt.checks.push('ui-v5-ask-bundle-truthful-deferred-initialize-and-actual-client-name');
  await drawer().getByRole('button', { name: 'Pause access', exact: true }).click();
  await waitSession(state => state.sessions.some(item => item.session_id === firstSession.session_id && item.state === 'paused'), 'UI pause');
  await client.call('inspect_source', { source_id: source.id }, true);
  await drawer().getByRole('button', { name: 'Resume access', exact: true }).click();
  await waitSession(state => state.sessions.some(item => item.session_id === firstSession.session_id && item.state === 'connected_idle'), 'UI resume');
  assert.equal((await client.call('inspect_source', { source_id: source.id })).verified, true);
  receipt.checks.push('ui-pause-and-resume-enforce-real-sdk-admission');
  const decision = { result_id: humanResult.id, revision_hash: humanResult.revision_hash, disposition: 'reviewed', reason: 'Automated packaged synthetic session-control check; no biological assessment.', coverage: 'Exact generated synthetic result revision only.', expected_review_sha256: null };
  const approvalCall = client.call('review_result', { request: decision });
  const approval = await pendingApproval('review_result', humanResult.id, humanResult.revision_hash);
  assert.equal(approval.session_id, firstSession.session_id);
  assert.equal(approval.policy_sha256, policySha);
  assert.equal(approval.request_hash, requestHash(policySha, 'review_result', decision));
  await checkpoint('review-awaiting-exact-approval');
  assert.equal((await client.command({ action: 'ping' })).pong, true, 'Controller and transport remain responsive while the tool waits');
  await drawer().getByRole('button', { name: 'Approve review_result', exact: true }).click();
  const reviewed = (await approvalCall).review;
  assert.equal(reviewed.actor, 'agent');
  assert.equal(reviewed.authority.policy_sha256, policySha);
  await waitSession(state => state.approvals.some(item => item.id === approval.id && item.state === 'consumed'), 'single-use approval consumed');
  const history = await client.call('review_history', { result_id: humanResult.id });
  assert.equal(history.total_events, 1);
  const excluded = { ...decision, disposition: 'excluded', reason: 'Automated denied request must not persist.', expected_review_sha256: history.current_review_sha256 };
  const deniedCall = client.call('review_result', { request: excluded }, true);
  const denied = await pendingApproval('review_result', humanResult.id, humanResult.revision_hash);
  assert.notEqual(denied.id, approval.id);
  await drawer().getByRole('button', { name: 'Deny review_result', exact: true }).click();
  await deniedCall;
  await waitSession(state => state.approvals.some(item => item.id === denied.id && item.state === 'denied'), 'UI denial persisted');
  assert.deepEqual((await client.call('review_history', { result_id: humanResult.id })).events, history.events);
  receipt.checks.push('ui-approve-once-and-deny-during-live-sdk-call-exact-revision-no-human-review-impersonation');
  const modeDecision = { ...excluded, reason: 'Automated full-access transition within the existing grant.' };
  const modeCall = client.call('review_result', { request: modeDecision });
  await pendingApproval('review_result', humanResult.id, humanResult.revision_hash);
  await drawer().getByLabel('Agent permission mode', { exact: true }).selectOption('full_access');
  assert.equal((await modeCall).review.actor, 'agent');
  await waitSession(state => state.pending_approval_count === 0 && state.policies.some(item => item.policy_sha256 === policySha && item.permission_mode === 'full_access'), 'full access settles pending prompt');
  receipt.checks.push('ui-full-access-mode-switch-settles-live-pending-request');
  await closeDrawer();
  await selectedResult(humanResult.id).click();
  await selectWorkbenchTool(page, 'Display');
  const viewer = page.locator(`[data-viewer-source="${source.id}"]`);
  await viewer.locator('.image-view-tools').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await delay(1800); // Existing source-view debounce and 1.5-second human-interaction quiet period.
  const before = await viewerState(source.id);
  assert.equal(before.selected_result, humanResult.id);
  const offJob = (await client.call('submit_recipe', { request: approved, request_key: 'follow-off' })).job;
  const offCompleted = await waitJob(offJob.id);
  await selectedResult(offCompleted.result_ids[0]).waitFor();
  const after = await viewerState(source.id);
  assert.equal(after.selected_result, before.selected_result);
  assert.deepEqual(after.camera, before.camera);
  assert.deepEqual(after.analysis_controls, before.analysis_controls);
  assert.deepEqual(after.source_view.state.selection, before.source_view.state.selection);
  assert.deepEqual(after.source_view.state.camera, before.source_view.state.camera);
  receipt.follow_off = { before, after, job_id: offJob.id, result_id: offCompleted.result_ids[0] };
  await checkpoint('completed-job-follow-off-stable-human-view');
  await openDrawer();
  assert.equal(await drawer().getByLabel('Follow agent', { exact: true }).isChecked(), false);
  await drawer().getByLabel('Follow agent', { exact: true }).check();
  await closeDrawer();
  await delay(1800); // Follow never queues a result to interrupt a later human action.
  const onJob = (await client.call('submit_recipe', { request: approved, request_key: 'follow-on' })).job;
  const onCompleted = await waitJob(onJob.id);
  await waitForSnapshot(page, snapshot => snapshot.results.some(item => item.id === onCompleted.result_ids[0]), 'completed followed result');
  await page.waitForFunction(id => document.querySelector(`.research-sources [data-result-id="${id}"]`)?.getAttribute('aria-pressed') === 'true', onCompleted.result_ids[0]);
  const followedSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const ownerSession = sessionById(followedSnapshot, firstSession.session_id);
  assert.ok(ownerSession.owned_job_ids.includes(onJob.id));
  assert.ok(ownerSession.recent_result_ids.includes(onCompleted.result_ids[0]));
  receipt.follow_on = { job_id: onJob.id, result_id: onCompleted.result_ids[0], selected_result: (await viewerState(source.id)).selected_result };
  receipt.checks.push('agent-owned-completed-results-refresh-without-human-view-change-unless-follow-enabled-and-idle');
  await checkpoint('follow-on-exact-owned-result');
  await openDrawer();
  await drawer().getByLabel('Follow agent', { exact: true }).uncheck();
  await drawer().getByRole('button', { name: 'Disconnect client', exact: true }).click();
  await waitSession(state => state.connected_count === 0 && state.sessions.some(item => item.session_id === firstSession.session_id && item.state === 'disconnected'), 'UI disconnect');
  await client.call('review_result', { request: { ...decision, result_id: onCompleted.result_ids[0], revision_hash: followedSnapshot.results.find(item => item.id === onCompleted.result_ids[0]).revision_hash } }, true);
  const rejectedSnapshot = await rawSnapshot();
  assert.equal(rejectedSnapshot.results.find(item => item.id === onCompleted.result_ids[0]).review, null);
  receipt.checks.push('ui-disconnect-rejects-mutation-from-still-open-stdio-client');
  await client.close();
  client = sdkClient(policyPath, 'Loci packaged session QA 2');
  await client.ready;
  await client.command({ action: 'initialize' });
  const reconnected = await waitSession(state => state.connected_count > 0 && state.sessions.some(item => item.client_id === 'Loci packaged session QA 2'), 'distinct reconnect');
  const secondSession = sessions(reconnected).sessions.find(item => item.client_id === 'Loci packaged session QA 2');
  assert.notEqual(secondSession.session_id, firstSession.session_id);
  assert.equal(sessionById(reconnected, firstSession.session_id).state, 'disconnected');
  receipt.second_session_id = secondSession.session_id;
  assert.equal((await client.call('inspect_source', { source_id: source.id })).verified, true);
  await openDrawer();
  await drawer().getByRole('button', { name: 'Revoke access', exact: true }).click();
  await waitSession(state => state.connected_count === 0 && state.policies.some(item => item.policy_sha256 === policySha && item.revoked), 'UI revoke');
  await client.call('review_result', { request: decision }, true);
  const final = await checkpoint('reconnect-revoke-human-job-preserved');
  const remainingHumanJob = final.jobs.find(item => item.id === humanQueued.id);
  assert.equal(remainingHumanJob.state, 'queued');
  assert.equal(remainingHumanJob.cancel_requested, false);
  assert.equal(remainingHumanJob.owner, undefined);
  assert.equal(final.jobs.find(item => item.id === offJob.id).state, 'succeeded');
  assert.equal(final.jobs.find(item => item.id === onJob.id).state, 'succeeded');
  assert.equal(await fs.stat(policyPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
  receipt.checks.push('distinct-reconnect-retains-terminal-old-session-ui-revoke-preserves-real-human-queued-job');
  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(await packageIdentity(), receipt.build);
  assert.equal(await hash(fixture.source), fixture.sha256);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = error.stack;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  const cleanupErrors = [];
  for (const controller of clients) await controller.close().catch(error => cleanupErrors.push(error.stack));
  if (app) await app.close().catch(error => cleanupErrors.push(error.stack));
  receipt.renderer_errors = rendererErrors;
  receipt.cleanup_errors = cleanupErrors;
  if (cleanupErrors.length) receipt.status = 'failed';
  receipt.finished_at = new Date().toISOString();
  await saveReceipt();
  console.log(output);
  if (cleanupErrors.length && !receipt.failure) throw new Error(cleanupErrors.join('\n'));
}
