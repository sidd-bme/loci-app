/** Lead-run packaged agent-window acceptance; preparation never executes this file.
 * Node 24/macOS: LOCI_PACKAGED_APP, LOCI_QA_PYTHON, LOCI_QA_OUTPUT_ROOT (absolute),
 * LOCI_QA_SOURCE_COMMIT (exact clean package SHA). Optional LOCI_QA_SECONDARY_DISPLAY
 * is an actual Electron display ID or exact label; a missing requested display fails.
 * Main placement prefers Sidecar/iPad with a receipted primary fallback if needed
 * for the live window minimum. Popup sizes and layout checks remain independent.
 * Uses an authored synthetic TIFF, supported frozen-worker CLI, real renderer UI,
 * native BrowserWindows and the existing MCP SDK controller. This is not an LLM-host
 * journey. Only study-open and access-bundle save picker answers are substituted.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { placeQaWindow } from './display-placement.mjs';
import { selectWorkbenchTool, setSelectionField } from '../../desktop/tests/workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..'), env = process.env;
const require = createRequire(path.join(repo, 'desktop/package.json'));
const { _electron: electron } = require('playwright'), exec = promisify(execFile);
assert.equal(process.platform, 'darwin', 'Supported packaged macOS only');
assert.equal(process.versions.node.split('.')[0], '24', 'Use supported Node 24');
const required = name => { assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be absolute`); return env[name]; };
const bundle = required('LOCI_PACKAGED_APP'), python = required('LOCI_QA_PYTHON'), outputRoot = required('LOCI_QA_OUTPUT_ROOT');
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/u);
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, 'packaged-agent-workspace-'));
const executable = path.join(bundle, 'Contents/MacOS/Loci'), worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const asar = path.join(bundle, 'Contents/Resources/app.asar'), identityFile = path.join(bundle, 'Contents/Resources/loci-build-identity.json');
const helper = path.join(repo, 'scripts/qa/agent-session-client.py'), fixtureHelper = path.join(repo, 'scripts/qa/agent-workbench-client.py');
const study = path.join(output, 'Agent workspace.loci-study'), access = path.join(output, 'agent-access'), profile = path.join(output, 'profile');
const hash = async file => { assert.ok((await fs.lstat(file)).isFile(), `Expected a plain evidence file: ${file}`); const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { schema: 'loci.packaged-agent-workspace-qa/v1', status: 'running', started_at: new Date().toISOString(), output,
  source_commit: env.LOCI_QA_SOURCE_COMMIT, stage: 'identity', build: {}, checks: [], captures: [], dialogs: [], calls: [], clients: [], processes: [],
  page_errors: [], console_errors: [], network_requests: [], cleanup_errors: [],
  limits: ['Generated synthetic image; engineering acceptance only, no biological accuracy or human scientific review.',
    'Live sessions use the actual local MCP SDK stdio controller and frozen worker. No Codex/LLM host or observed model identity is claimed.',
    'Study-open and access-bundle save dialog answers are explicitly simulated. Native close means BrowserWindow.close(), not a manual red-button click.',
    'Display inventory and placement are real. Physical Sidecar unplug/reconnect is not performed by this harness.',
    'Navigation is exercised on exact source/result revisions within one generated source; cross-source and interrupted-command races retain their separate regression coverage.'],
  model_observed: null, physical_display_disconnect_exercised: false };
let app, page, popup, failure, fixture, source, result, client, policyHash, savedBounds;
const controllers = [];
const saveReport = () => writeJson(path.join(output, 'receipt.json'), report);
const packageHashes = async () => ({ executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker), build_identity_sha256: await hash(identityFile) });
const cli = async (...args) => JSON.parse((await exec(worker, ['--loci', '--json', ...args], { timeout: 30000, maxBuffer: 8 * 1024 ** 2 })).stdout);
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const workspaceState = (target = page) => target.evaluate(() => window.lociAgentWorkspace.state());
async function wait(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(100); }
  throw new Error(`${label}: timed out; last=${JSON.stringify(last)}`);
}
const tasks = value => value.agent_sessions?.tasks ?? [];
async function checkpoint(name) {
  const file = path.join(output, `${String(report.checks.length).padStart(2, '0')}-${name}.json`);
  await writeJson(file, { snapshot: await snapshot(), native: await workspaceState() });
  report.checks.push({ name, evidence: path.basename(file), sha256: await hash(file) }); await saveReport();
}
function observe(target, label) {
  target.setDefaultTimeout(30000);
  target.on('pageerror', error => report.page_errors.push({ window: label, message: error.message }));
  target.on('console', message => { if (message.type() === 'error') report.console_errors.push({ window: label, message: message.text() }); });
  target.on('request', request => { if (/^https?:/u.test(request.url())) report.network_requests.push({ window: label, url: request.url() }); });
}
async function shot(target, name) {
  const file = path.join(output, name + '.png');
  await target.screenshot({ path: file, animations: 'disabled' });
  const geometry = await target.evaluate(() => {
    const surface = document.querySelector('.agent-workspace-surface'), columns = document.querySelector('.agent-workspace-columns');
    return { viewport: [innerWidth, innerHeight], dpi: devicePixelRatio, theme: document.documentElement.dataset.theme,
      horizontal_overflow: document.documentElement.scrollWidth - innerWidth,
      surface_overflow: surface ? surface.scrollWidth - surface.clientWidth : null,
      grid_columns: columns ? getComputedStyle(columns).gridTemplateColumns : null };
  });
  assert.ok(geometry.horizontal_overflow <= 1, `${name}: document clips horizontally`);
  if (geometry.surface_overflow !== null) assert.ok(geometry.surface_overflow <= 1, `${name}: agent surface clips horizontally`);
  report.captures.push({ name, file: path.basename(file), sha256: await hash(file), geometry });
  return geometry;
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], cwd: path.join(repo, 'desktop'), timeout: 120000,
    env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  page = await app.firstWindow(); observe(page, 'main');
  const { inventory } = await placeQaWindow(app, { requestedDisplay: env.LOCI_QA_SECONDARY_DISPLAY, margin: 15, launch: (report.display_placements?.length ?? 0) + 1 }, report);
  await app.evaluate(({ dialog }, paths) => {
    globalThis.__agentWorkspaceQaDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title !== 'Open research study') throw new Error('Unexpected open picker: ' + options?.title);
      globalThis.__agentWorkspaceQaDialogs.push({ title: options.title, simulated: true, selected_basename: paths.study.split('/').at(-1) });
      return { canceled: false, filePaths: [paths.study] };
    };
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title !== 'Create private MCP access bundle') throw new Error('Unexpected save picker: ' + options?.title);
      globalThis.__agentWorkspaceQaDialogs.push({ title: options.title, simulated: true, selected_basename: paths.access.split('/').at(-1) });
      return { canceled: false, filePath: paths.access };
    };
    dialog.showMessageBox = async (...args) => { throw new Error('Unexpected confirmation: ' + args.at(-1)?.message); };
  }, { study, access });
  report.display_inventory ??= inventory;
  report.latest_display_inventory = inventory;
  if (env.LOCI_QA_SECONDARY_DISPLAY) assert.ok(inventory.displays.some(d => String(d.id) === env.LOCI_QA_SECONDARY_DISPLAY || d.label === env.LOCI_QA_SECONDARY_DISPLAY), 'The explicitly requested display is unavailable');
  await page.waitForFunction(() => Boolean(window.lociResearch && window.lociAgentWorkspace));
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace', exact: true }).waitFor();
  await wait(workspaceState, value => value.binding && value.freshness === 'current', 'study-bound publisher');
}
async function openDrawer() {
  const trigger = page.getByRole('button', { name: 'Agent session status', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('region', { name: 'Agent session and approvals', exact: true }).waitFor();
}
async function popOut(restore = false) {
  const created = app.waitForEvent('window', { timeout: 30000 });
  if (restore) await page.evaluate(() => window.lociAgentWorkspace.restore());
  else { await openDrawer(); await page.getByRole('button', { name: 'Pop out', exact: true }).click(); }
  popup = await created; observe(popup, 'agent-workspace');
  await popup.getByRole('heading', { name: 'Agent workspace', exact: true }).waitFor();
  await wait(() => workspaceState(popup), value => value.role === 'workspace' && value.status === 'open' && value.freshness === 'current', 'native popup ready');
  return popup;
}
async function nativeClosePopup() {
  const closed = popup.waitForEvent('close');
  const native = await app.browserWindow(popup);
  await native.evaluate(window => window.close());
  await closed; await native.dispose(); popup = undefined;
  await wait(workspaceState, state => state.status === 'docked', 'native close handed draft back');
}
async function placePopup(width, height) {
  const inventory = await app.evaluate(({ screen }) => ({ primary: screen.getPrimaryDisplay().id, displays: screen.getAllDisplays().map(d => ({ id: d.id, label: d.label, workArea: d.workArea })) }));
  const explicit = env.LOCI_QA_SECONDARY_DISPLAY;
  const desired = explicit ? inventory.displays.find(d => String(d.id) === explicit || d.label === explicit)
    : inventory.displays.find(d => /sidecar|ipad/iu.test(d.label ?? ''));
  if (explicit) assert.ok(desired, 'Requested display disconnected before placement');
  const fits = d => d.workArea.width >= width + 24 && d.workArea.height >= Math.min(height, 600) + 24;
  const selected = desired && fits(desired) ? desired : inventory.displays.find(d => d.id === inventory.primary && fits(d));
  assert.ok(selected, `No connected display fits the ${width}px agent workspace`);
  const bounds = { x: selected.workArea.x + 12, y: selected.workArea.y + 12, width, height: Math.min(height, selected.workArea.height - 24) };
  const native = await app.browserWindow(popup); await native.evaluate((window, value) => window.setBounds(value), bounds);
  const actual = await native.evaluate(window => window.getNormalBounds()); await native.dispose();
  assert.equal(actual.width, width); assert.ok(actual.height >= 480);
  await popup.waitForFunction(expected => innerWidth === expected, width);
  report.checks.push({ name: 'actual-display-placement', requested: bounds, actual, display: selected,
    sidecar_identified_by_label: /sidecar|ipad/iu.test(selected.label ?? ''), requested_secondary_used: Boolean(desired && selected.id === desired.id) });
  return actual;
}
async function setTheme(theme) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Application theme' }).selectOption(theme);
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await popup.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
}
async function readProcesses() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => { const fields = line.trim().split(/\s+/u); return [Number(fields[0]), { parent: Number(fields[1]), start: fields.slice(2).join(' ') }]; }));
}
async function closeRuntime() {
  const before = await readProcesses(), roots = [app?.process().pid, ...controllers.filter(c => c.child.exitCode === null).map(c => c.child.pid)].filter(Boolean);
  const owned = new Set(roots);
  for (;;) { const size = owned.size; for (const [pid, row] of before) if (owned.has(row.parent)) owned.add(pid); if (owned.size === size) break; }
  const identities = [...owned].filter(pid => before.has(pid)).map(pid => ({ pid, start: before.get(pid).start }));
  const errors = [];
  for (const controller of controllers) await controller.close().catch(error => errors.push(error.stack));
  if (app) {
    const current = app;
    report.dialogs.push(...await current.evaluate(() => globalThis.__agentWorkspaceQaDialogs ?? []).catch(() => []));
    const stopped = current.waitForEvent('close', { timeout: 30000 }); stopped.catch(() => {});
    try { await current.evaluate(({ app }) => app.quit()); await stopped; } catch (error) { errors.push(error.stack); }
    finally { app = undefined; page = undefined; popup = undefined; await current.close().catch(error => errors.push(error.stack)); }
  }
  let rows = await readProcesses(), survivors = identities.filter(p => rows.get(p.pid)?.start === p.start);
  for (let attempt = 0; attempt < 20 && survivors.length; attempt++) { await delay(100); rows = await readProcesses(); survivors = identities.filter(p => rows.get(p.pid)?.start === p.start); }
  const record = { scope: 'Identity-pinned descendant inventory before shutdown, not continuous tracing', observed: identities, survivors_after_ordinary_shutdown: survivors };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const process of survivors) if ((await readProcesses()).get(process.pid)?.start === process.start) {
      try { globalThis.process.kill(process.pid, signal); } catch (error) { if (error.code !== 'ESRCH') errors.push(error.stack); }
    }
    if (survivors.length) await delay(300);
    rows = await readProcesses(); survivors = identities.filter(p => rows.get(p.pid)?.start === p.start);
  }
  record.final_survivors = survivors; report.processes.push(record);
  if (record.survivors_after_ordinary_shutdown.length) errors.push('Ordinary shutdown required forced descendant cleanup.');
  if (survivors.length) errors.push('Owned descendant processes survived cleanup.');
  if (errors.length) { report.cleanup_errors.push(...errors); throw new Error(errors.join('\n')); }
}
function sdkClient(policy) {
  const name = 'Loci packaged agent workspace SDK QA';
  const child = spawn(python, [helper, 'serve', worker, policy, '--client-name', name], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, failure = null, stderr = '', closing = false;
  const pending = new Map(), info = { name, controller_pid: child.pid, transport: null, exit: null };
  report.clients.push(info);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  const readyTimer = setTimeout(() => readyReject(new Error('MCP transport initialization exceeded 30 seconds')), 30000);
  const rejectPending = error => { failure = error; clearTimeout(readyTimer); readyReject(error); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.stderr.on('data', data => { stderr += data; }); child.on('error', rejectPending);
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch (error) { rejectPending(error); return; }
    if (value.event === 'transport_ready') { clearTimeout(readyTimer); info.transport = value; readyResolve(value); return; }
    const request = pending.get(value.id); if (!request) { rejectPending(new Error('Unexpected MCP controller response: ' + line)); return; }
    pending.delete(value.id); clearTimeout(request.timer);
    if (value.controller_error) request.reject(new Error(`${value.controller_error}: ${value.message}`)); else request.resolve(value);
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { info.exit = { code, signal }; if (!closing || code !== 0) rejectPending(new Error(`MCP controller exited (${code ?? signal}): ${stderr}`)); resolve(info.exit); }));
  const command = request => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId, response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} exceeded 45 seconds`)); }, 45000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, ...request }) + '\n');
    }); response.catch(() => {}); return response;
  };
  const controller = { child, ready, command,
    call(name, args, expectedError = false) {
      const response = command({ action: 'call', name, arguments: args }).then(value => {
        report.calls.push({ name, arguments: args, expected_error: expectedError, ...value });
        assert.equal(value.is_error, expectedError, `${name}: ${JSON.stringify(value)}`);
        return value.structured_content;
      }); response.catch(() => {}); return response;
    },
    async close() {
      if (closing) return; closing = true;
      try {
        if (child.exitCode === null && !failure) await command({ action: 'close' }); child.stdin.end();
        let timeout;
        try { const exit = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MCP controller did not exit within 10 seconds')), 10000); })]); assert.equal(exit.code, 0); }
        finally { clearTimeout(timeout); }
      } finally { clearTimeout(readyTimer); await fs.writeFile(path.join(output, `mcp-${report.clients.indexOf(info) + 1}-stderr.log`), stderr); }
    } };
  controllers.push(controller); return controller;
}
async function preservedArrays(record) {
  const values = {};
  for (const [name, value] of Object.entries(record.arrays ?? {})) { assert.match(value.sha256, /^[a-f0-9]{64}$/u); values[name] = await hash(path.join(study, 'artifacts', value.sha256 + '.npy')); assert.equal(values[name], value.sha256); }
  return values;
}

try {
  report.build = await packageHashes(); report.build.identity = await json(identityFile);
  assert.equal(report.build.identity.sourceRevision, env.LOCI_QA_SOURCE_COMMIT);
  assert.equal(report.build.identity.sourceDirty, false, 'Packaged qualification requires a clean recorded candidate');
  report.harness_sha256 = await hash(import.meta.filename); report.helper_sha256 = await hash(helper); report.fixture_helper_sha256 = await hash(fixtureHelper);
  report.display_helper_sha256 = await hash(path.join(repo, 'scripts/qa/display-placement.mjs'));
  await saveReport();
  report.stage = 'generated-fixture-and-native-study';
  fixture = JSON.parse((await exec(python, [helper, 'fixture', output], { timeout: 30000 })).stdout);
  assert.equal(path.dirname(fixture.source), output); assert.equal(await hash(fixture.source), fixture.sha256); report.fixture = fixture;
  await cli('create', '--project', study, '--title', 'Agent workspace · generated fixture');
  source = (await cli('import', '--project', study, fixture.source)).sources[0]; assert.equal(source.sha256, fixture.sha256);
  const request = { source_id: source.id, selection: fixture.selection, recipe: { segmentation: { method: 'components', threshold: 50, min_size: 1 }, measurement_channels: [0] } };
  const requestFile = path.join(output, 'baseline-request.json'); await writeJson(requestFile, request);
  const baseline = await cli('submit', '--project', study, '--request', '@' + requestFile, '--request-key', 'agent-window-baseline', '--run');
  assert.equal(baseline.job.state, 'succeeded'); result = baseline.result; assert.equal(result.object_count, fixture.expected_objects); assert.equal(result.review ?? null, null);
  report.baseline = { source_id: source.id, source_sha256: source.sha256, result_id: result.id, revision_hash: result.revision_hash, arrays: await preservedArrays(result) };
  await launch();
  report.stage = 'bounded-task-grant';
  await selectWorkbenchTool(page, 'Display');
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) await setSelectionField(page, label, fixture.selection[key]);
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical');
  await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  await page.getByLabel('Threshold', { exact: true }).fill('50');
  await page.getByLabel('Minimum object measure', { exact: true }).fill('1'); await page.getByLabel('Minimum object measure', { exact: true }).press('Tab');
  await selectWorkbenchTool(page, 'Agent'); const panel = page.locator('.research-agent');
  await panel.getByLabel('Session permission mode', { exact: true }).selectOption('full_access');
  await panel.getByText('Customize permissions', { exact: true }).click();
  await panel.getByLabel('Share plans and assessments', { exact: true }).check();
  await panel.getByLabel('Allow display-only recipe previews', { exact: true }).check();
  await panel.getByLabel('Agent result scope', { exact: true }).selectOption('granted-sources');
  for (const disclosure of ['geometry', 'source_names', 'previews', 'measurements', 'provenance', 'agent_metadata']) await panel.getByLabel('Disclose ' + disclosure, { exact: true }).check();
  await panel.getByRole('button', { name: 'Validate exact scope and recipe', exact: true }).click();
  await panel.getByLabel('Exact recipe validation', { exact: true }).waitFor();
  await panel.getByRole('button', { name: `Grant selected access to ${source.name}`, exact: true }).click();
  await panel.getByLabel('Created agent access receipt', { exact: true }).waitFor();
  const policyPath = path.join(access, 'agent-policy.json'), policy = await json(policyPath);
  assert.equal(policy.permission_mode, 'full_access'); assert.ok(policy.operations.includes('agent_task_write')); assert.equal(policy.operations.includes('review_result'), false);
  policyHash = await hash(policyPath); report.policy_sha256 = policyHash;
  const config = (await json(path.join(access, 'mcp-config.json'))).mcpServers['loci-research'];
  assert.equal(config.command, worker); assert.deepEqual(config.args, ['--cli', 'mcp', '--policy', policyPath]);
  await wait(snapshot, value => value.agent_sessions?.connected_count === 0 && value.agent_sessions?.policies.some(p => p.policy_sha256 === policyHash), 'bundle ready without connection');
  client = sdkClient(policyPath); assert.equal((await client.ready).initialized, false);
  assert.equal((await snapshot()).agent_sessions.connected_count, 0);
  await client.command({ action: 'initialize' });
  const connected = await wait(snapshot, value => value.agent_sessions?.connected_count === 1, 'real initialized SDK session');
  report.session_id = connected.agent_sessions.sessions.find(s => s.policy_sha256 === policyHash && s.state === 'connected_idle')?.session_id; assert.ok(report.session_id);
  const taskId = randomUUID().replaceAll('-', ''); report.task_id = taskId;
  const sourceTarget = { kind: 'source', id: source.id, sha256: source.sha256, selection: fixture.selection };
  const resultTarget = { kind: 'result', id: result.id, revision_hash: result.revision_hash, source_id: source.id, source_sha256: source.sha256 };
  const initialGoal = 'Inspect the generated source and its exact retained labels';
  await client.call('agent_task_write', { operation: 'publish_plan', request: { task_id: taskId, expected_revision: 0, goal: initialGoal, state: 'active',
    steps: [{ id: 'inspect', title: 'Inspect source and labels', state: 'planned', note: 'Generated fixture; no biological validity claim.', targets: [sourceTarget, resultTarget] }], targets: [sourceTarget, resultTarget] } });
  await wait(snapshot, value => tasks(value).some(t => t.id === taskId && t.revision === 1), 'durable MCP task publication');
  await openDrawer(); await page.getByText(initialGoal, { exact: true }).waitFor(); await shot(page, '01-docked-plan');
  report.stage = 'draft-transfer-and-native-close';
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  const firstDraft = 'Unsaved main-window plan before detaching'; await page.getByRole('textbox', { name: 'Goal', exact: true }).fill(firstDraft);
  await popOut(); assert.equal(await popup.getByRole('textbox', { name: 'Goal', exact: true }).inputValue(), firstDraft);
  const isolated = await popup.evaluate(() => ({ api: Object.keys(window.lociAgentWorkspace).sort(), desktop: typeof window.loci, research: typeof window.lociResearch,
    images: typeof window.lociImageWindows, node: typeof window.require, process: typeof window.process }));
  assert.equal(isolated.desktop, 'undefined'); assert.equal(isolated.research, 'undefined'); assert.equal(isolated.images, 'undefined'); assert.equal(isolated.node, 'undefined'); assert.equal(isolated.process, 'undefined'); assert.equal(isolated.api.includes('execute'), false);
  const forbiddenOpen = await popup.evaluate(async () => { try { await window.lociAgentWorkspace.open(); return { rejected: false }; } catch (error) { return { rejected: true, message: String(error) }; } });
  assert.equal(forbiddenOpen.rejected, true); report.preload_isolation = { ...isolated, main_only_open: forbiddenOpen };
  const state = await workspaceState(popup); assert.equal(state.binding.projectId, (await snapshot()).project.project_id);
  assert.equal(state.snapshot.sources.find(s => s.id === source.id).sha256, source.sha256);
  const firstWindow = (await app.browserWindow(popup)); const windowId = await firstWindow.evaluate(w => w.id); await firstWindow.dispose();
  await page.getByRole('button', { name: 'Agent session status', exact: true }).click();
  assert.equal((await app.windows()).length, 2, 'Repeated open must focus one existing agent window');
  const secondDraft = 'Latest popup draft survives ordinary native close'; await popup.getByRole('textbox', { name: 'Goal', exact: true }).fill(secondDraft);
  await nativeClosePopup();
  await page.getByRole('textbox', { name: 'Goal', exact: true }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Goal', exact: true }).inputValue(), secondDraft);
  const unsaved = tasks(await snapshot()).find(t => t.id === taskId); assert.equal(unsaved.goal, initialGoal); assert.equal(unsaved.revision, 1);
  await page.getByRole('button', { name: 'Save plan', exact: true }).click();
  await wait(snapshot, value => tasks(value).some(t => t.id === taskId && t.goal === secondDraft && t.revision === 2 && t.updated_by === 'human'), 'main UI saved exact transferred draft');
  await popOut();
  await popup.getByRole('button', { name: 'Edit plan', exact: true }).click();
  const thirdDraft = 'Popup draft returns through the explicit dock control'; await popup.getByRole('textbox', { name: 'Goal', exact: true }).fill(thirdDraft);
  const returned = popup.waitForEvent('close'); await popup.getByRole('button', { name: 'Return to workspace', exact: true }).click(); await returned; popup = undefined;
  assert.equal(await page.getByRole('textbox', { name: 'Goal', exact: true }).inputValue(), thirdDraft);
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click(); await popOut();
  assert.equal(await popup.getByRole('form', { name: 'Edit agent plan' }).count(), 0);
  assert.equal(tasks((await workspaceState(popup)).snapshot).find(t => t.id === taskId).goal, secondDraft);
  report.draft_handoff = { first_window_id: windowId, initial_revision: 1, saved_revision: 2, direct_close: true, dock_control: true, mcp_session_unchanged: report.session_id };
  assert.equal((await snapshot()).agent_sessions.connected_count, 1);
  await checkpoint('draft-transfer-preload-isolation');
  report.stage = 'exact-navigation-and-shared-controls';
  for (const [intent, target] of [['open-source', sourceTarget], ['open-result', resultTarget]]) {
    const receipt = await popup.evaluate(async ({ intent, target }) => {
      const state = await window.lociAgentWorkspace.state();
      return window.lociAgentWorkspace.navigate(state.binding, { requestId: crypto.randomUUID(), intent, target });
    }, { intent, target });
    assert.equal(receipt.accepted, true);
    const rendered = await page.evaluate(({ source, result, intent }) => {
      const viewer = document.querySelector(`[data-viewer-source="${source}"][data-prepared="true"]`);
      const chosen = document.querySelector(`button[data-result-id="${result.id}"][aria-pressed="true"]`);
      const exactOverlay = document.querySelector(`[data-result-overlay="${result.id}:${result.revision_hash}"][data-prepared="true"]`);
      const retained = [...document.querySelectorAll('img[alt="Exact selected result revision"]')].some(image => image.complete && image.naturalWidth > 0);
      return { source_ready: Boolean(viewer), result_selected: Boolean(chosen), exact_overlay: Boolean(exactOverlay), retained_rendered: retained,
        acknowledged_target_ready: intent === 'open-source' ? Boolean(viewer) : Boolean(chosen && (exactOverlay || retained)) };
    }, { source: source.id, result, intent });
    assert.equal(rendered.acknowledged_target_ready, true, 'Native acknowledgment must follow actual target selection/render');
    report.checks.push({ name: 'exact-navigation-ack', intent, target, receipt, rendered });
  }
  const staleNavigation = await popup.evaluate(async target => { const state = await window.lociAgentWorkspace.state(); try {
    await window.lociAgentWorkspace.navigate(state.binding, { requestId: crypto.randomUUID(), intent: 'open-result', target: { ...target, revision_hash: '0'.repeat(64) } }); return { rejected: false };
  } catch (error) { return { rejected: true, message: String(error) }; } }, resultTarget);
  assert.equal(staleNavigation.rejected, true); report.checks.push({ name: 'stale-recorded-revision-refused', ...staleNavigation });
  await popup.getByLabel('Follow agent', { exact: true }).click();
  await wait(workspaceState, value => value.follow === true, 'Follow state shared with main');
  assert.equal(await popup.getByLabel('Follow agent', { exact: true }).isChecked(), true);
  await popup.getByLabel('Follow agent', { exact: true }).click(); await wait(workspaceState, value => value.follow === false, 'Follow disabled in main');
  assert.equal(await popup.getByLabel('Follow agent', { exact: true }).isChecked(), false);
  await popup.getByRole('button', { name: 'Pause access', exact: true }).click();
  await wait(snapshot, value => value.agent_sessions.policies.some(p => p.policy_sha256 === policyHash && p.paused), 'popup pause native policy');
  await client.call('inspect_source', { source_id: source.id }, true);
  await popup.getByRole('button', { name: 'Resume access', exact: true }).click();
  await wait(snapshot, value => value.agent_sessions.policies.some(p => p.policy_sha256 === policyHash && !p.paused), 'popup resume native policy');
  assert.equal((await client.call('inspect_source', { source_id: source.id })).verified, true);
  await popup.getByText('Connection and permissions', { exact: true }).click();
  await popup.getByLabel('Agent permission mode', { exact: true }).selectOption('ask_approval');
  await wait(snapshot, value => value.agent_sessions.policies.some(p => p.policy_sha256 === policyHash && p.permission_mode === 'ask_approval'), 'popup permission mode');
  const currentTask = tasks(await snapshot()).find(t => t.id === taskId);
  await client.call('agent_task_write', { operation: 'publish_assessment', request: { task_id: taskId, expected_revision: currentTask.revision,
    summary: 'The generated source and retained labels are linked to the same study.', observations: ['Three authored regions are retained in the baseline result.'],
    limitations: ['Generated technical fixture; no biological accuracy or human scientific review.'], targets: [sourceTarget, resultTarget] } });
  assert.equal((await snapshot()).agent_sessions.approvals.filter(a => a.state === 'pending').length, 0, 'Granted prose metadata does not execute analysis or require an execution approval');
  const approvedRequest = await json(path.join(access, 'approved-request.json'));
  const preview = client.call('preview_recipe', { request: approvedRequest });
  const pending = await wait(snapshot, value => value.agent_sessions.approvals.some(a => a.operation === 'preview_recipe' && a.state === 'pending'), 'actual SDK preview approval');
  const approval = pending.agent_sessions.approvals.find(a => a.operation === 'preview_recipe' && a.state === 'pending');
  assert.equal(approval.session_id, report.session_id); assert.equal(approval.policy_sha256, policyHash);
  await popup.getByRole('button', { name: 'Approve preview_recipe', exact: true }).click(); await preview;
  await wait(snapshot, value => value.agent_sessions.approvals.some(a => a.id === approval.id && a.state === 'consumed'), 'single-use popup approval consumed');
  assert.ok((await snapshot()).results.every(value => value.review == null), 'Preview approval must not create scientific result review');
  await checkpoint('live-controls-and-single-use-preview-approval');
  report.stage = 'real-layout-and-appearance';
  await popup.getByRole('button', { name: 'Overview', exact: true }).click();
  await popup.locator('.agent-workspace-content').evaluate(element => { element.scrollTop = 0; });
  await setTheme('graphite'); await placePopup(960, 760);
  const wide = await shot(popup, '02-detached-wide-graphite'); assert.equal(wide.grid_columns.split(' ').length, 2);
  await placePopup(520, 740); const narrow = await shot(popup, '03-detached-narrow-graphite'); assert.equal(narrow.grid_columns.split(' ').length, 1);
  await setTheme('paper'); await shot(popup, '04-detached-narrow-paper');
  await placePopup(960, 760); await shot(popup, '05-detached-wide-paper');
  await setTheme('graphite'); savedBounds = await placePopup(960, 760);
  await nativeClosePopup(); await popOut(true);
  const nativeRestored = await app.browserWindow(popup); const restoredBounds = await nativeRestored.evaluate(window => window.getNormalBounds()); await nativeRestored.dispose();
  assert.deepEqual(restoredBounds, savedBounds, 'Explicit restore must recover saved native bounds');
  report.checks.push({ name: 'explicit-layout-restore', saved: savedBounds, restored: restoredBounds });
  await nativeClosePopup();
  assert.equal(await hash(policyPath), policyHash); assert.equal(await hash(fixture.source), fixture.sha256); assert.deepEqual(await preservedArrays(result), report.baseline.arrays);
  report.stage = 'same-profile-cold-restore';
  await closeRuntime(); await launch();
  await wait(snapshot, value => value.agent_sessions.connected_count === 0, 'closed SDK must not restore a live claim');
  await popOut(true);
  const cold = await workspaceState(popup); assert.equal(cold.snapshot.agent_sessions.connected_count, 0); assert.equal(cold.presentation.draft, null);
  assert.equal(tasks(cold.snapshot).find(t => t.id === taskId).goal, secondDraft); assert.equal(tasks(cold.snapshot).find(t => t.id === taskId).assessments.length, 1);
  const nativeCold = await app.browserWindow(popup); const coldBounds = await nativeCold.evaluate(window => window.getNormalBounds()); await nativeCold.dispose();
  assert.deepEqual(coldBounds, savedBounds, 'Cold layout restore must preserve bounds while the same display remains connected');
  await shot(popup, '06-cold-retained-workspace');
  await checkpoint('cold-retained-task-no-live-connection');
  assert.equal(await hash(fixture.source), fixture.sha256); assert.deepEqual(await preservedArrays(result), report.baseline.arrays);
  assert.deepEqual(await packageHashes(), Object.fromEntries(Object.entries(report.build).filter(([key]) => key !== 'identity')));
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); assert.deepEqual(report.network_requests, []);
  report.stage = 'complete'; report.status = 'passed';
} catch (error) {
  failure = error; report.status = 'failed'; report.failure = error.stack;
  if (page && !page.isClosed()) await shot(page, 'failure-main').catch(() => {});
  if (popup && !popup.isClosed()) await shot(popup, 'failure-agent').catch(() => {});
} finally {
  await closeRuntime().catch(error => { report.status = 'failed'; report.failure ??= error.stack; failure ??= error; });
  report.finished_at = new Date().toISOString(); await saveReport(); console.log(output);
}
if (failure) throw failure;
