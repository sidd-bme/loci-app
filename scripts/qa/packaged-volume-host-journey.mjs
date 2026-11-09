/** Lead-run signed-app + actual Codex-host volume acceptance.
 *
 * Required absolute paths: LOCI_PACKAGED_APP, LOCI_QA_PYTHON,
 * LOCI_QA_VOLUME_FIXTURE, LOCI_QA_PARENT_STUDY, LOCI_QA_PARENT_RECEIPT,
 * LOCI_QA_OUTPUT_ROOT. Also LOCI_QA_PARENT_RESULT (exact ID) and
 * LOCI_QA_SOURCE_COMMIT (actual packaged revision). Node24/macOS only.
 * Optional LOCI_QA_ALLOW_CORRECTION=1 authorizes the helper's one final delete child.
 * LOCI_QA_HOST_SCOPE=correction-only runs just the explicit correction phase; its receipt
 * records partial scope and must not substitute for core/concurrency/reopen acceptance.
 * This copies the passed derived study; original fixtures/study remain immutable.
 * Optional LOCI_QA_SECONDARY_DISPLAY selects an Electron display ID or exact label.
 * Otherwise prefer Sidecar/iPad; use primary if unavailable or below the live window
 * minimum. Missing explicit displays fail. Actual placement/fallback is receipted.
 * Only Open study is simulated. Scene inputs use ordinary rendered UI controls.
 * No mailbox reply, adapter, product hook, transcript or screenshot is synthesized.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { placeQaWindow } from './display-placement.mjs';
import { fileMenuAction, waitForSnapshot, selectWorkbenchTool } from '../../desktop/tests/workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..'), env = process.env;
const require = createRequire(path.join(repo, 'desktop/package.json'));
const { _electron: electron } = require('playwright'), exec = promisify(execFile);
assert.equal(process.platform, 'darwin'); assert.equal(process.versions.node.split('.')[0], '24');
const absolute = name => { assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be explicit and absolute`); return env[name]; };
// Preserve the venv launcher path: resolving its interpreter symlink loses pyvenv.cfg.
const bundle = await fs.realpath(absolute('LOCI_PACKAGED_APP')), python = absolute('LOCI_QA_PYTHON');
await fs.access(python);
const fixturePath = await fs.realpath(absolute('LOCI_QA_VOLUME_FIXTURE')), parentStudy = await fs.realpath(absolute('LOCI_QA_PARENT_STUDY'));
const parentReceiptPath = await fs.realpath(absolute('LOCI_QA_PARENT_RECEIPT')), outputRoot = await fs.realpath(absolute('LOCI_QA_OUTPUT_ROOT'));
const parentId = env.LOCI_QA_PARENT_RESULT, sourceCommit = env.LOCI_QA_SOURCE_COMMIT;
assert.match(parentId ?? '', /^[a-f0-9]{32}$/u); assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const hostTimeout = Number(env.LOCI_QA_HOST_TIMEOUT_SECONDS ?? 900);
assert.ok(Number.isSafeInteger(hostTimeout) && hostTimeout >= 60 && hostTimeout <= 3600);
const allowCorrection = env.LOCI_QA_ALLOW_CORRECTION === '1';
const scope = env.LOCI_QA_HOST_SCOPE ?? 'complete';
assert.ok(['complete', 'correction-only'].includes(scope), 'Unknown host journey scope');
assert.ok(scope !== 'correction-only' || allowCorrection, 'Correction-only scope requires explicit correction authority');
const output = await fs.mkdtemp(path.join(outputRoot, 'packaged-volume-host-'));
const study = path.join(output, 'Host workspace.loci-study'), kit = path.join(output, 'actual-host-kit');
const helper = path.join(repo, 'scripts/qa_volume_agent_host.py'), worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const executable = path.join(bundle, 'Contents/MacOS/Loci'), asar = path.join(bundle, 'Contents/Resources/app.asar');
const humanEvidencePath = path.join(output, 'human.json'), reopenEvidencePath = path.join(output, 'reopen.json');
const hash = async file => { const digest = createHash('sha256'); for await (const b of createReadStream(file)) digest.update(b); return digest.digest('hex'); };
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const report = { schema: 'loci.packaged-volume-host-journey/v1', status: 'running', started_at: new Date().toISOString(), output, study,
  source_commit: sourceCommit, scope, requested_phases: scope === 'correction-only' ? ['correction'] : ['core', 'human', 'reopen', ...(allowCorrection ? ['correction'] : [])], commands: [], phases: [], gui_launches: [], dialogs: [], captures: [], processes: [], page_errors: [], console_errors: [], network_requests: [],
  limits: ['Engineering acceptance only; no biological validation, human scientific review or observed model-identity claim.',
    'The passed derived study is copied into this exclusive run. Source images and the original study are never written.',
    'Open study responses are explicitly simulated; no ordinary native-dialog acceptance is claimed here.',
    'Human-CAS input is automated through ordinary GUI controls after an actual Codex progress marker; it is not human scientific review.',
    'Core enqueue/cancel is a real race. A completed image request is a cancellation failure; this run never relabels or retries it.',
    'Process ownership combines sampled native PID/start-time ancestry with the actual host helper server-exit receipts.',
    'Display inventory and placement are real; physical Sidecar unplug/reconnect is not exercised by this harness.'] };
let fixture, parentReceipt, parent, source, app, page, activeProfile, failure, monitor, monitorQueue = Promise.resolve();
const owned = new Map(), roots = new Map(), activeChildren = new Set();
let markerIntervention = false;
const announce = (event, details = {}) => console.log(JSON.stringify({ event, ...details }));
async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000, maxBuffer: 4 * 1024 ** 2 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => { const fields = line.trim().split(/\s+/u); return [Number(fields[0]), { parent: Number(fields[1]), start: fields.slice(2).join(' ') }]; }));
}
async function rememberProcesses() {
  const table = await processTable(), family = new Map();
  for (const [pid, root] of roots) {
    if (root.child.exitCode !== null || root.child.signalCode !== null) { roots.delete(pid); continue; }
    if (table.has(pid)) family.set(pid, root.role);
  }
  for (const [pid, record] of owned) if (table.get(pid)?.start === record.start) family.set(pid, record.role);
  for (;;) { const count = family.size; for (const [pid, row] of table) if (family.has(row.parent)) family.set(pid, family.get(row.parent)); if (count === family.size) break; }
  for (const [pid, role] of family) if (table.has(pid)) owned.set(pid, { pid, start: table.get(pid).start, role });
}
async function registerProcess(child, role) { assert.ok(Number.isSafeInteger(child.pid)); roots.set(child.pid, { role, child }); await rememberProcesses(); }
async function liveOwned(role = null) { const table = await processTable(); return [...owned.values()].filter(p => (!role || p.role === role) && table.get(p.pid)?.start === p.start); }
async function cleanupOwned(records) {
  let survivors = records;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const record of survivors) if ((await processTable()).get(record.pid)?.start === record.start) try { process.kill(record.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (survivors.length) await new Promise(resolve => setTimeout(resolve, 300));
    const table = await processTable(); survivors = records.filter(record => table.get(record.pid)?.start === record.start);
  }
  return survivors;
}
async function inventory(directory) {
  const entries = [];
  async function visit(current) { for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name); assert.equal((await fs.lstat(file)).isSymbolicLink(), false, 'Derived-study copies must not follow symlinks');
    if (entry.isDirectory()) await visit(file); else { assert.ok(entry.isFile()); entries.push({ path: path.relative(directory, file), sha256: await hash(file) }); }
  } }
  await visit(directory); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
function startCommand(name, program, args, timeout = 60000) {
  const stdoutPath = path.join(output, name + '.stdout.log'), stderrPath = path.join(output, name + '.stderr.log');
  const out = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 }), err = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const record = { name, program, args, started_at: new Date().toISOString(), stdout: stdoutPath, stderr: stderrPath }; report.commands.push(record);
  const sinkClosed = sink => new Promise(resolve => { sink.once('close', resolve); sink.once('error', resolve); });
  const stdoutClosed = sinkClosed(out), stderrClosed = sinkClosed(err);
  const child = spawn(program, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] }); activeChildren.add(child);
  child.stdout.pipe(out); child.stderr.pipe(err); record.pid = child.pid;
  if (child.pid) { roots.set(child.pid, { role: name, child }); monitorQueue = monitorQueue.then(rememberProcesses).catch(error => { report.process_tracking_error = error.message; }); }
  let timedOut = false, escalation;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000); }, timeout);
  const done = new Promise((resolve, reject) => {
    const ioFailure = error => { record.io_error = error.message; child.kill('SIGTERM'); reject(error); };
    out.once('error', ioFailure); err.once('error', ioFailure);
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); activeChildren.delete(child); if (roots.get(child.pid)?.child === child) roots.delete(child.pid); record.spawn_error = error.message; out.end(); err.end(); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation); activeChildren.delete(child);
      if (roots.get(child.pid)?.child === child) roots.delete(child.pid);
      void (async () => {
        await Promise.all([stdoutClosed, stderrClosed]);
        record.finished_at = new Date().toISOString(); record.exit_code = code; record.signal = signal; record.timed_out = timedOut;
        record.stdout_sha256 = await hash(stdoutPath); record.stderr_sha256 = await hash(stderrPath);
        return { code, signal, timedOut };
      })().then(resolve, reject);
    });
  });
  return { child, done, record };
}
async function command(name, program, args, timeout) {
  announce('command-started', { name }); const handle = startCommand(name, program, args, timeout); const result = await handle.done;
  assert.equal(result.timedOut, false, `${name} exceeded its bounded timeout`); assert.equal(result.code, 0, `${name} failed; retained logs: ${handle.record.stderr}`);
  announce('command-completed', { name }); return handle.record;
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const scene = () => page.evaluate(sourceId => window.lociResearch.execute('volume_view', { source_id: sourceId }), source.id);
async function wait(read, accept, label, timeout = 60000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    if (report.process_tracking_error) throw new Error(report.process_tracking_error);
    for (const alert of await page.locator('.research-alert[role="alert"], .volume-workspace-message[role="alert"]').all()) if (await alert.isVisible()) throw new Error(`${label}: ${await alert.textContent()}`);
    last = await read(); if (accept(last)) return last; await page.waitForTimeout(150);
  }
  throw new Error(`${label}: timed out; ${JSON.stringify(last)}`);
}
async function capture(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' }); const artifact = { path: file, sha256: await hash(file) }; report.captures.push(artifact); return artifact; }
async function stableScene(predicate, label) {
  let prior = null, stable = 0;
  return wait(scene, value => {
    if (!predicate(value)) { prior = null; stable = 0; return false; }
    stable = prior && same(prior, value) ? stable + 1 : 0; prior = value; return stable >= 2;
  }, label, 120000);
}
async function launch(number) {
  activeProfile = path.join(output, 'profile-' + number); await fs.mkdir(activeProfile, { mode: 0o700 });
  app = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + activeProfile], cwd: path.join(repo, 'desktop'), timeout: 120000,
    env: { ...env, LOCI_MODEL_HOME: path.join(activeProfile, 'models') } });
  await registerProcess(app.process(), 'app-' + number);
  const record = { number, pid: app.process().pid, profile: activeProfile, started_at: new Date().toISOString() }; report.gui_launches.push(record);
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.page_errors.push({ launch: number, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.console_errors.push({ launch: number, message: message.text() }); });
  page.on('request', request => { if (/^https?:/u.test(request.url())) report.network_requests.push({ launch: number, url: request.url() }); });
  await placeQaWindow(app, { requestedDisplay: env.LOCI_QA_SECONDARY_DISPLAY, margin: 10, launch: number }, report);
  await app.evaluate(({ dialog }, selectedStudy) => {
    globalThis.__volumeHostDialogs = [];
    dialog.showOpenDialog = async (...args) => { const title = args.at(-1)?.title; if (title !== 'Open research study') throw new Error('Unexpected picker: ' + title);
      globalThis.__volumeHostDialogs.push({ title, simulated: true, selected_basename: selectedStudy.split('/').at(-1) }); return { canceled: false, filePaths: [selectedStudy] }; };
    dialog.showSaveDialog = async (...args) => { throw new Error('Unexpected save picker: ' + args.at(-1)?.title); };
    dialog.showMessageBox = async (...args) => { throw new Error('Unexpected confirmation: ' + args.at(-1)?.message); };
  }, study);
  await page.waitForFunction(() => Boolean(window.lociResearch));
  await page.locator('main.image-first-empty, main.image-first-workbench').waitFor({ timeout: 120000 });
  await fileMenuAction(page, 'Open study');
  const current = await waitForSnapshot(page, value => value?.results.some(r => r.id === parentId) === true, 'exact copied parent study', 120000);
  parent = current.results.find(r => r.id === parentId); source = current.sources.find(s => s.id === parent.source_id);
  assert.equal(parent.revision_hash, parentReceipt.parent.revision_hash); assert.equal(source.sha256, fixture.source.sha256);
  await page.locator(`button[data-source-id="${source.id}"]`).click(); await page.locator(`button[data-result-id="${parentId}"]`).click();
  await page.locator(`button[data-result-id="${parentId}"][aria-pressed="true"]`).waitFor();
  const open = page.getByRole('button', { name: '3D volume', exact: true }); if (await open.isVisible()) await open.click();
  if (number === 1) await page.getByRole('button', { name: 'Four panes', exact: true }).click();
  await page.getByRole('region', { name: 'Raw whole-volume viewport', exact: true }).waitFor();
  await wait(() => page.locator('.raw-volume').getAttribute('data-layout'), value => value === 'four', 'four actual visible panes', 120000);
  for (const pane of ['axial', 'coronal', 'sagittal']) await page.locator(`[data-pane="${pane}"] canvas`).waitFor({ state: 'visible' });
  await page.locator('.raw-volume-stage canvas').first().waitFor({ state: 'visible' });
  if (number === 1) {
    await stableScene(value => value.state?.result?.result_id === parent.id && value.state.camera, 'initial parent scene before channel selection');
    if (!(await scene()).state.channels.includes(fixture.selection.c)) {
      await selectWorkbenchTool(page, 'Population');
      const channelName = source.metadata.channel_names?.[fixture.selection.c] ?? `Channel ${fixture.selection.c + 1}`;
      const channel = page.getByRole('checkbox', { name: `${channelName} visible`, exact: true });
      const disclosure = page.locator('details.compact-channel-controls');
      await disclosure.waitFor({ state: 'visible' });
      if (!await disclosure.evaluate(element => element.open)) await page.locator('details.compact-channel-controls > summary').click();
      await channel.waitFor({ state: 'visible' });
      if (await channel.isChecked()) await channel.uncheck();
      await channel.check();
    }
  }
  const saved = await stableScene(value => value.state?.result?.result_id === parent.id && value.state.result.revision_hash === parent.revision_hash &&
    value.state.result.label_sha256 === fixture.numerical_label_sha256 && value.state.camera && value.state.layout.mode === 'four' &&
    value.state.t === fixture.selection.t && value.state.channels.includes(fixture.selection.c), 'exact saved GUI scene');
  record.saved_scene = saved; record.ready_at = new Date().toISOString(); await capture('launch-' + number + '-ready'); return record;
}
async function closeNormally(number) {
  if (!app) return;
  await rememberProcesses(); const role = 'app-' + number, before = await liveOwned(role);
  report.dialogs.push(...await app.evaluate(() => globalThis.__volumeHostDialogs ?? []));
  const current = app, processHandle = current.process(), closed = current.waitForEvent('close', { timeout: 30000 }); let quitError;
  try { await current.evaluate(({ app }) => app.quit()); await closed; } catch (error) { quitError = error; }
  finally { app = undefined; page = undefined; if (quitError) await current.close().catch(() => {}); if (roots.get(processHandle.pid)?.child === processHandle) roots.delete(processHandle.pid); }
  let survivors = await liveOwned(role);
  for (let i = 0; i < 30 && survivors.length; i++) { await new Promise(resolve => setTimeout(resolve, 100)); survivors = await liveOwned(role); }
  const record = { role, before_quit: before, survivors_after_quit: survivors, ordinary_quit: !quitError };
  if (survivors.length) record.final_survivors = await cleanupOwned(survivors); else record.final_survivors = [];
  report.processes.push(record); assert.deepEqual(record.final_survivors, []); assert.deepEqual(record.survivors_after_quit, [], 'Owned GUI processes required forced cleanup');
  if (quitError) throw quitError;
}
async function runPhase(phase, extra = []) {
  const record = { phase, started_at: new Date().toISOString() }; report.phases.push(record);
  await command(phase + '-run', python, [helper, 'run-host', '--kit', kit, '--phase', phase, '--timeout', String(hostTimeout), ...extra], (hostTimeout + 60) * 1000);
  record.host_run = path.join(kit, phase, 'host-run.json'); record.host_run_sha256 = await hash(record.host_run);
  await command(phase + '-verify', python, [helper, 'verify', '--run', path.join(kit, phase)], 120000);
  const verificationPath = path.join(kit, phase, 'verification.json'), verification = await readJson(verificationPath);
  assert.equal(verification.status, 'passed-actual-codex-host-engineering');
  record.verification = { path: verificationPath, sha256: await hash(verificationPath) }; record.finished_at = new Date().toISOString();
  return verification;
}
function structured(item) {
  const result = item.result ?? {}; let value = result.structuredContent ?? result.structured_content;
  if (value === undefined) { const blocks = (result.content ?? []).filter(b => b.type === 'text'); assert.equal(blocks.length, 1); value = JSON.parse(blocks[0].text); }
  return value;
}
async function waitForHumanMarker(handle) {
  const transcript = path.join(kit, 'human/codex-events.jsonl'); let finished = false, exit;
  handle.done.then(value => { finished = true; exit = value; }, error => { finished = true; exit = error; });
  const stop = Date.now() + hostTimeout * 1000;
  while (Date.now() < stop) {
    let text = '';
    try { const info = await fs.stat(transcript); assert.ok(info.size <= 256 * 1024 ** 2); text = await fs.readFile(transcript, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lines = text.split('\n'); if (lines.at(-1)) lines.pop();
    let original = null;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue; const event = JSON.parse(line), item = event.item;
      assert.ok(!event.simulated && !event.event_origin, 'Only actual Codex events may trigger human input');
      if (event.type === 'item.completed' && item?.type === 'mcp_tool_call' && item.server === 'loci-volume-qa' && item.tool === 'volume_view' && !original) {
        assert.ok(!item.result?.isError && !item.result?.is_error); original = structured(item);
      }
      if (event.type === 'item.completed' && item?.type === 'agent_message' && /\bREADY_FOR_HUMAN_CAS\b/u.test(item.text ?? '')) {
        assert.ok(original?.live?.available && original.live.busy === false, 'The marker must follow a genuine ready native scene read');
        return { transcript, line: index + 1, event, original };
      }
    }
    assert.equal(finished, false, 'Human host exited before its real marker: ' + JSON.stringify(exit));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Actual Codex human-CAS progress marker was not observed');
}
async function setHumanClipping() {
  const detail = page.locator('details.raw-volume-rendering-detail');
  const wasOpen = await detail.getAttribute('open') !== null;
  if (!wasOpen) await detail.locator('summary').click();
  await page.getByLabel('Clip', { exact: true }).check(); await page.getByLabel('Clipping axis', { exact: true }).selectOption('2');
  const range = page.getByLabel('Clipping position', { exact: true });
  await range.evaluate((input, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native range setter unavailable');
    setter.call(input, String(next)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 73);
  assert.equal(Number(await range.inputValue()), 73);
  if (!wasOpen) await detail.locator('summary').click();
}
try {
  fixture = await readJson(fixturePath); parentReceipt = await readJson(parentReceiptPath);
  assert.equal(fixture.schema, 'loci.volume-workspace-fixture/v1'); assert.equal(parentReceipt.schema, 'loci.packaged-volume-workspace-qa/v1');
  assert.equal(parentReceipt.status, 'passed-packaged-engineering'); assert.equal(parentReceipt.parent.id, parentId);
  assert.equal(await fs.realpath(parentReceipt.study), parentStudy); assert.equal(parentReceipt.fixture.sha256, await hash(fixturePath));
  assert.equal(parentReceipt.close_error, undefined);
  for (const p of parentReceipt.processes ?? []) { assert.deepEqual(p.final_survivors, []); assert.deepEqual(p.survivors_after_quit, []); }
  assert.equal(await hash(fixture.source.path), fixture.source.sha256); assert.equal(await hash(fixture.labels.path), fixture.labels.sha256);
  report.input = { parent_study: parentStudy, parent_result: parentReceipt.parent, prior_receipt: { path: parentReceiptPath, sha256: await hash(parentReceiptPath), source_commit: parentReceipt.source_commit }, fixture: { path: fixturePath, sha256: await hash(fixturePath) } };
  report.original_study_inventory = await inventory(parentStudy); await fs.cp(parentStudy, study, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  report.build = { identity: await readJson(path.join(bundle, 'Contents/Resources/loci-build-identity.json')), executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker) };
  assert.equal(report.build.identity.sourceRevision, sourceCommit); report.harness_sha256 = await hash(import.meta.filename); report.host_helper_sha256 = await hash(helper);
  report.display_helper_sha256 = await hash(path.join(repo, 'scripts/qa/display-placement.mjs'));
  await writeJson(path.join(output, 'attempt.json'), { schema: report.schema, started_at: report.started_at, input: report.input, build: report.build, source_commit: sourceCommit, scope, requested_phases: report.requested_phases });
  await command('codesign', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], 60000);
  monitor = setInterval(() => { monitorQueue = monitorQueue.then(rememberProcesses).catch(error => { report.process_tracking_error = error.message; }); }, 250);
  const firstLaunch = await launch(1); const firstBefore = await scene();
  await writeJson(path.join(output, 'initial-gui-scene.json'), firstBefore);
  await command('prepare-host', python, [helper, 'prepare', '--fixture', fixturePath, '--study', study, '--result-id', parentId, '--worker', worker,
    '--source-commit', sourceCommit, '--output', kit, ...(allowCorrection ? ['--allow-correction'] : [])], 120000);
  const prepared = await readJson(path.join(kit, 'prepared.json')); assert.equal(prepared.study, study); assert.equal(prepared.result_binding.result_id, parentId);
  report.prepared = { path: path.join(kit, 'prepared.json'), sha256: await hash(path.join(kit, 'prepared.json')) };
  if (scope === 'complete') {
    const core = await runPhase('core'); assert.equal(core.cancelled_requests.length, 1, 'Completion cannot substitute for actual cancellation');
    const humanPhase = { phase: 'human', started_at: new Date().toISOString() }; report.phases.push(humanPhase);
    const human = startCommand('human-run', python, [helper, 'run-host', '--kit', kit, '--phase', 'human', '--human-evidence', humanEvidencePath, '--timeout', String(hostTimeout)], (hostTimeout + 60) * 1000);
    const marker = await waitForHumanMarker(human); await writeJson(path.join(output, 'human-marker.json'), marker); markerIntervention = true;
    const before = await scene(); assert.deepEqual(before.state, marker.original.state); assert.equal(before.revision, marker.original.revision);
    assert.notDeepEqual(before.state.clipping, { enabled: true, axis: 'z', position_percent: 73 }, 'The human marker must be a new ordinary-input change');
    const beforeCapture = await capture('human-before'); await setHumanClipping();
    const after = await stableScene(value => value.revision > before.revision && same(value.state.clipping, { enabled: true, axis: 'z', position_percent: 73 }), 'human clipping CAS marker');
    const afterCapture = await capture('human-after');
    await writeJson(humanEvidencePath, { schema: 'loci.volume-host-human-edit/v1', route: 'ordinary GUI controls', actor: 'Playwright automation of the human-side UI; not human scientific review', before, after,
      marker: { transcript: marker.transcript, line: marker.line }, captures: [beforeCapture, afterCapture] });
    const humanExit = await human.done; assert.equal(humanExit.timedOut, false); assert.equal(humanExit.code, 0, 'Human host failed; its actual transcript and logs are preserved');
    await command('human-verify', python, [helper, 'verify', '--run', path.join(kit, 'human')], 120000);
    const humanVerificationPath = path.join(kit, 'human/verification.json'), humanVerification = await readJson(humanVerificationPath);
    assert.equal(humanVerification.status, 'passed-actual-codex-host-engineering'); assert.deepEqual(humanVerification.expected_denials, ['stale']);
    assert.deepEqual(humanVerification.final_view.state, after.state);
    humanPhase.verification = { path: humanVerificationPath, sha256: await hash(humanVerificationPath) }; humanPhase.finished_at = new Date().toISOString();
    const beforeCloseCapture = await capture('before-normal-close'); await closeNormally(1);
    const secondLaunch = await launch(2); assert.notEqual(firstLaunch.pid, secondLaunch.pid); assert.notEqual(firstLaunch.profile, secondLaunch.profile);
    const restored = await stableScene(value => same(value.state, humanVerification.final_view.state) && value.geometry_sha256 === humanVerification.final_view.geometry_sha256, 'exact cold-restored human scene');
    const reopenedCapture = await capture('fresh-profile-reopened');
    await writeJson(reopenEvidencePath, { schema: 'loci.volume-host-reopen/v1', fresh_profile: true, study,
      before_app_pid: firstLaunch.pid, after_app_pid: secondLaunch.pid, before_profile: firstLaunch.profile, after_profile: secondLaunch.profile,
      before: humanVerification.final_view, after: restored, captures: [beforeCloseCapture, reopenedCapture] });
    await runPhase('reopen', ['--expected-view', humanVerificationPath, '--reopen-evidence', reopenEvidencePath]);
  }
  if (allowCorrection) await runPhase('correction');
  await capture('final-host-scene'); await closeNormally(scope === 'complete' ? 2 : 1);
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); assert.deepEqual(report.network_requests, []);
  assert.deepEqual(await inventory(parentStudy), report.original_study_inventory, 'The passed original study changed');
  assert.equal(await hash(fixture.source.path), fixture.source.sha256); assert.equal(await hash(fixture.labels.path), fixture.labels.sha256);
  assert.deepEqual(report.phases.map(phase => phase.phase), report.requested_phases);
  report.status = scope === 'complete' ? 'passed-actual-host-and-packaged-engineering' : 'passed-correction-host-and-packaged-engineering'; report.originals_preserved = true;
} catch (error) {
  failure = error; report.status = 'failed'; report.failure = { message: error.message, stack: error.stack, human_marker_observed: markerIntervention };
  if (page) await capture('failure').catch(() => {});
} finally {
  for (const child of activeChildren) { try { child.kill('SIGTERM'); } catch { /* Ownership cleanup below verifies process identity. */ } }
  if (failure) {
    await rememberProcesses(); const runningHosts = (await liveOwned()).filter(record => !record.role.startsWith('app-'));
    if (runningHosts.length) report.host_cleanup_on_failure = { before: runningHosts, survivors: await cleanupOwned(runningHosts) };
  }
  if (app) try { await closeNormally(report.gui_launches.at(-1)?.number ?? 1); } catch (error) { report.close_error = error.message; failure ??= error; report.status = 'failed'; }
  clearInterval(monitor); await monitorQueue;
  let survivors = await liveOwned(); report.final_survivors_before_cleanup = survivors;
  if (survivors.length) { report.final_survivors = await cleanupOwned(survivors); report.status = 'failed'; failure ??= new Error('Owned app/host processes survived ordinary completion'); }
  else report.final_survivors = [];
  if (report.process_tracking_error) { report.status = 'failed'; failure ??= new Error(report.process_tracking_error); }
  if (report.original_study_inventory) {
    try {
      assert.deepEqual(await inventory(parentStudy), report.original_study_inventory);
      assert.equal(await hash(fixture.source.path), fixture.source.sha256); assert.equal(await hash(fixture.labels.path), fixture.labels.sha256);
      assert.equal(await hash(parentReceiptPath), report.input.prior_receipt.sha256);
      if (report.build) {
        assert.equal(await hash(executable), report.build.executable_sha256); assert.equal(await hash(asar), report.build.asar_sha256); assert.equal(await hash(worker), report.build.worker_sha256);
      }
      if (report.harness_sha256) assert.equal(await hash(import.meta.filename), report.harness_sha256);
      if (report.display_helper_sha256) assert.equal(await hash(path.join(repo, 'scripts/qa/display-placement.mjs')), report.display_helper_sha256);
      report.originals_preserved = true;
    } catch (error) { report.originals_preserved = false; report.preservation_error = error.message; report.status = 'failed'; failure ??= error; }
  }
  report.finished_at = new Date().toISOString(); await writeJson(path.join(output, 'receipt.json'), report);
}
announce('journey-finished', { output, status: report.status, receipt: path.join(output, 'receipt.json') });
if (failure) throw failure;
