/** Packaged renderer + actual Codex-host task acceptance.
 *
 * Lead-only execution, Node 24, with LOCI_PACKAGED_APP, LOCI_QA_PYTHON,
 * LOCI_EXTERNAL_HOST_ROOT (unused synthetic preparation --wait-for-human-edit,
 * or fluorescence preparation without human-edit synchronization),
 * LOCI_QA_OUTPUT_ROOT and LOCI_QA_SECONDARY_DISPLAY. NODE_OPTIONS must import
 * scripts/qa/secondary-display-loader.mjs before this script runs.
 * Open-study picker responses are simulated and recorded. Human plan editing,
 * task rendering and evidence navigation use real renderer controls. Opening a
 * review panel does not record a scientific review. No native-picker acceptance,
 * custom-method execution, biological validation or model observation is claimed.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { constants, createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileMenuAction, selectResultSection, selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(repo, 'desktop/package.json'));
const { _electron: electron } = require('playwright');
const exec = promisify(execFile), env = process.env;
assert.equal(process.platform, 'darwin', 'This journey requires packaged macOS');
assert.equal(process.versions.node.split('.')[0], '24', 'Use supported Node 24');
for (const name of ['LOCI_PACKAGED_APP', 'LOCI_QA_PYTHON', 'LOCI_EXTERNAL_HOST_ROOT', 'LOCI_QA_OUTPUT_ROOT'])
  assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be an explicit absolute path`);
assert.ok(env.LOCI_QA_SECONDARY_DISPLAY, 'An explicit nonprimary display is required');
assert.ok((env.NODE_OPTIONS ?? '').includes('secondary-display-loader.mjs'),
  'Import the secondary-display loader before any Electron launch; no primary-display fallback');

const bundle = await fs.realpath(env.LOCI_PACKAGED_APP);
// Python selects its virtual environment from the invoked executable path.
// Resolving this symlink would silently invoke the base interpreter instead.
const python = path.resolve(env.LOCI_QA_PYTHON);
await fs.access(python, constants.X_OK);
const hostRoot = await fs.realpath(env.LOCI_EXTERNAL_HOST_ROOT);
const prepared = JSON.parse(await fs.readFile(path.join(hostRoot, 'prepared-fixture.json'), 'utf8'));
const fixture = prepared.fixture;
assert.ok(['synthetic', 'fluorescence'].includes(prepared.case), 'Unsupported prepared image example');
assert.equal(fixture.case, prepared.case, 'Prepared fixture case identity differs');
const humanSync = prepared.case === 'synthetic';
assert.equal(fixture.wait_for_human_edit, humanSync,
  'Synthetic requires human-edit synchronization; fluorescence must leave it disabled');
assert.equal(prepared.output, hostRoot, 'Prepared root identity differs');
const HUMAN_EDIT_GOAL = 'Human-edited goal: inspect exact labels and preserve annotation limits';
const humanTitles = ['Human edit: inspect images and exact measurements', 'Human edit: compare labels with explicit limits'];
if (humanSync) {
  assert.equal(fixture.human_edit_goal, HUMAN_EDIT_GOAL);
  assert.equal(fixture.plan_request.steps.length, humanTitles.length);
}
const expectedGoal = humanSync ? HUMAN_EDIT_GOAL : fixture.plan_request.goal;
const expectedTitles = humanSync ? humanTitles : fixture.plan_request.steps.map(step => step.title);
const expectedRevision = humanSync ? 5 : 2;
const executable = path.join(bundle, 'Contents/MacOS/Loci');
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
assert.equal(await fs.realpath(prepared.worker.worker_path), await fs.realpath(worker),
  'The host and renderer must use the exact same packaged worker');
const harness = path.join(repo, 'scripts/qa/codex-external-agent.py');
const output = await fs.mkdtemp(path.join(env.LOCI_QA_OUTPUT_ROOT, `agent-task-workspace-${prepared.case}-`));
const receiptPath = path.join(output, 'receipt.json');
const sha = async file => {
  assert.equal((await fs.lstat(file)).isFile(), true, `Expected plain file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const absent = async file => {
  try { await fs.lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};
const receipt = {
  schema: 'loci.packaged-agent-task-workspace-qa/v1', status: 'running', output,
  case: prepared.case, human_plan_edit_requested: humanSync, human_plan_edit_exercised: false,
  host_root: hostRoot, started_at: new Date().toISOString(), human_review: false,
  biological_validation: false, model_observed: null,
  limits: [
    'Open-study picker responses are explicitly simulated; no native-picker acceptance claim.',
    'The external agent is the actual ephemeral Codex CLI host, not an SDK substitute.',
    'Controlled-method values are authored data adopted by the native fixture; custom code is not executed.',
    'Cold retained reads use a copied completed study, an absent prepared source and an empty model home; decoder entry points are not instrumented.',
    'Settings and Guide visual acceptance remains a separate lead-owned journey.',
  ],
  screenshots: [], dialogs: [], renderer_errors: [], network_requests: [], processes: [], checks: [],
};
let app, page, host, hostResult, hostPromise, hostStreams = [], tick, inputOffline;
let scan = Promise.resolve(), scanning = false, activeStudy = prepared.study, stage = 'initializing', aborted;
const owned = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const binding = result => ({ result_id: result.id, revision_hash: result.revision_hash });
const tasks = snapshot => snapshot.agent_sessions?.tasks ?? [];
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) =>
  window.lociResearch.execute(operation, request), { operation, request });

async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/u);
    return [Number(fields[0]), { parent: Number(fields[1]), start: fields.slice(2).join(' ') }];
  }));
}

async function remember() {
  const rows = await processes(), roots = new Set();
  if (app?.process()?.pid) roots.add(app.process().pid);
  if (host?.pid && hostResult === undefined) roots.add(host.pid);
  for (const [pid, record] of owned) if (rows.get(pid)?.start === record.start) roots.add(pid);
  for (;;) {
    const count = roots.size;
    for (const [pid, row] of rows) if (roots.has(row.parent)) roots.add(pid);
    if (count === roots.size) break;
  }
  for (const pid of roots) if (rows.has(pid)) owned.set(pid, { start: rows.get(pid).start });
}

async function nonprimary(label) {
  assert.ok(app, `App absent during ${label}`);
  const state = await app.evaluate((_electron) => {
    const { BrowserWindow, screen } = _electron;
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('No main window');
    const bounds = window.getBounds(), display = screen.getDisplayMatching(bounds);
    return { bounds, display_id: display.id, primary_id: screen.getPrimaryDisplay().id,
      work_area: display.workArea, displays: screen.getAllDisplays().map(d => ({ id: d.id, label: d.label })) };
  });
  assert.notEqual(state.display_id, state.primary_id, `${label}: main window reached primary display`);
  assert.ok(state.displays.some(d => d.id === state.display_id), `${label}: selected display vanished`);
  if (receipt.display_id !== undefined) assert.equal(state.display_id, receipt.display_id,
    `${label}: nonprimary display changed; no fallback permitted`);
  else receipt.display_id = state.display_id;
  const area = state.work_area, b = state.bounds;
  assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width &&
    b.y + b.height <= area.y + area.height, `${label}: window leaves selected display work area`);
  return state;
}

async function wait(read, accept, label, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (aborted) throw aborted;
    if (hostResult && hostResult.code !== 0) throw new Error(`Actual host failed (${hostResult.code}); see stream logs`);
    const value = await read();
    if (accept(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function shot(name) {
  await nonprimary(name);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  receipt.screenshots.push({ name, path: file, sha256: await sha(file) });
}

async function installPicker() {
  await app.evaluate((_electron, study) => {
    const { dialog } = _electron;
    globalThis.__agentTaskDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Open research study') throw new Error(`Unexpected simulated picker: ${title}`);
      globalThis.__agentTaskDialogs.push({ title, simulation: true, selected_basename: study.split('/').at(-1) });
      return { canceled: false, filePaths: [study] };
    };
  }, activeStudy);
}

async function launch(number) {
  const profile = path.join(output, `profile-${number}`);
  app = await electron.launch({ executablePath: executable,
    args: [`--user-data-dir=${profile}`], cwd: path.join(repo, 'desktop'), timeout: 120000,
    env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  await remember();
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push({ stage, message: error.message }));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.lociResearch));
  receipt.checks.push({ check: 'nonprimary-placement', launch: number, state: await nonprimary(`launch-${number}`) });
  await installPicker();
}

async function openStudy() {
  await fileMenuAction(page, 'Open study');
  await page.locator('main.image-first-workbench').waitFor();
  return wait(snapshot, s => s?.project?.project_id, 'opened exact study');
}

async function drawer() {
  const trigger = page.getByRole('button', { name: 'Agent session status', exact: true });
  await trigger.waitFor();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('region', { name: 'Agent session and approvals', exact: true }).waitFor();
  const follow = page.getByRole('checkbox', { name: 'Follow agent', exact: true });
  if (await follow.isChecked()) await follow.uncheck();
  return page.getByRole('region', { name: 'External agent plans and assessments', exact: true });
}

async function buildIdentity() {
  const meta = path.join(bundle, 'Contents/Resources/loci-build-identity.json');
  return { app: bundle, executable_sha256: await sha(executable), asar_sha256: await sha(path.join(bundle, 'Contents/Resources/app.asar')),
    worker_sha256: await sha(worker), manifest_sha256: await sha(meta), manifest: await json(meta) };
}

async function startHost() {
  for (const name of ['host-attempt.json', 'host-run.json', 'codex-events.jsonl'])
    assert.equal(await absent(path.join(hostRoot, name)), true, `Prepared host root already attempted: ${name}`);
  const stdout = createWriteStream(path.join(output, 'host-runner-stdout.log'), { flags: 'wx' });
  const stderr = createWriteStream(path.join(output, 'host-runner-stderr.log'), { flags: 'wx' });
  hostStreams = [stdout, stderr];
  await Promise.all(hostStreams.map(stream => once(stream, 'open')));
  const args = [harness, 'run-host', '--output', hostRoot, '--timeout', '1800'];
  receipt.host_command = { command: python, args };
  host = spawn(python, args, { cwd: repo, detached: true, stdio: ['ignore', stdout, stderr], env });
  hostPromise = new Promise(resolve => {
    host.once('error', error => { hostResult = { code: null, error: error.message }; resolve(hostResult); });
    host.once('close', (code, signal) => { hostResult = { code, signal }; resolve(hostResult); });
  });
  await remember();
  await wait(() => absent(path.join(hostRoot, 'host-attempt.json')), missing => !missing,
    'exclusive actual-host attempt marker');
}

async function closeApp() {
  if (!app) return;
  await remember();
  receipt.dialogs.push(...await app.evaluate((_electron) => globalThis.__agentTaskDialogs ?? []));
  const current = app;
  const closed = current.waitForEvent('close', { timeout: 30000 });
  let error;
  try { await current.evaluate((_electron) => { _electron.app.quit(); }); await closed; }
  catch (caught) { error = caught; await current.close().catch(() => {}); }
  finally { app = undefined; page = undefined; }
  if (error) throw error;
}

async function cleanupOwned() {
  await scan.catch(() => {});
  let rows = await processes();
  for (let i = 0; i < 20 && [...owned].some(([pid, record]) => rows.get(pid)?.start === record.start); i++) {
    await pause(100); rows = await processes();
  }
  let remaining = [...owned].filter(([pid, record]) => rows.get(pid)?.start === record.start);
  const entry = { observed: [...owned].map(([pid, record]) => ({ pid, ...record })),
    survivors_before_cleanup: remaining.map(([pid]) => pid) };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const [pid, record] of remaining) if ((await processes()).get(pid)?.start === record.start)
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (remaining.length) await pause(500);
    rows = await processes(); remaining = [...owned].filter(([pid, record]) => rows.get(pid)?.start === record.start);
  }
  entry.final_survivors = remaining.map(([pid]) => pid); receipt.processes.push(entry);
  assert.deepEqual(entry.final_survivors, [], 'Owned process cleanup left survivors');
  return entry;
}

async function stopHostOnFailure() {
  if (host && hostResult === undefined) {
    const rows = await processes();
    if (rows.get(host.pid)?.start === owned.get(host.pid)?.start)
      try { process.kill(-host.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function filesUnder(directory) {
  if (await absent(directory)) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'Unexpected model-home symlink');
    if (entry.isDirectory()) values.push(...await filesUnder(file));
    else values.push(file);
  }
  return values;
}

async function treeHashes(directory) {
  const files = (await filesUnder(directory)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(directory, file), await sha(file)])));
}

async function waitOwnedExit(label) {
  await wait(processes, rows => [...owned].every(([pid, record]) => rows.get(pid)?.start !== record.start), label, 10000);
}

process.once('SIGINT', () => { aborted = new Error('Interrupted by SIGINT'); void stopHostOnFailure(); });
process.once('SIGTERM', () => { aborted = new Error('Interrupted by SIGTERM'); void stopHostOnFailure(); });

let failure;
try {
  receipt.identity = await buildIdentity();
  assert.equal(receipt.identity.worker_sha256, prepared.worker.worker_sha256);
  receipt.script_sha256 = await sha(import.meta.filename);
  receipt.prepared_sha256 = await sha(path.join(hostRoot, 'prepared-fixture.json'));
  receipt.harness_sha256 = await sha(harness);
  tick = setInterval(() => {
    if (scanning) return;
    scanning = true;
    scan = remember().catch(error => { aborted = error; }).finally(() => { scanning = false; });
  }, 250);
  await launch(1);
  stage = 'starting-actual-host';
  // Opening a study can persist native display state. Let the host validate its
  // untouched study first; its exclusive marker proves that preflight finished.
  await startHost();
  const initial = await openStudy();
  receipt.project_id = initial.project.project_id;
  stage = humanSync ? 'real-human-plan-edit' : 'visible-external-plan';
  const first = await wait(snapshot, s => tasks(s).some(t => t.id === fixture.task_id &&
    (humanSync ? t.revision === 1 : t.revision >= 1 && t.revision <= expectedRevision)), 'visible external plan');
  const originalPlan = tasks(first).find(t => t.id === fixture.task_id);
  assert.equal(originalPlan.goal, fixture.plan_request.goal);
  assert.deepEqual(originalPlan.steps, fixture.plan_request.steps);
  assert.deepEqual(originalPlan.targets, fixture.plan_request.targets);
  let retainedPlan = originalPlan;
  const panel = await drawer();
  await panel.getByRole('heading', { name: 'Task plan', exact: true }).waitFor();
  assert.equal(await panel.locator('.agent-task-goal').innerText(), originalPlan.goal);
  await writeJson(path.join(output, 'plan-before.json'), originalPlan);
  await shot('01-visible-external-plan');
  if (humanSync) {
    await panel.getByRole('button', { name: 'Edit plan', exact: true }).click();
    const editor = panel.getByRole('form', { name: 'Edit agent plan', exact: true });
    await editor.getByRole('textbox', { name: 'Goal', exact: true }).fill(HUMAN_EDIT_GOAL);
    for (let index = 0; index < humanTitles.length; index++)
      await editor.getByRole('textbox', { name: `Step ${index + 1}`, exact: true }).fill(humanTitles[index]);
    await shot('02-human-plan-draft');
    await editor.getByRole('button', { name: 'Save plan', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await wait(async () => panel.locator('.agent-task-goal').innerText(), text => text === HUMAN_EDIT_GOAL,
      'visible saved human goal');
    const edited = await wait(snapshot, s => tasks(s).some(t => t.id === fixture.task_id && t.revision >= 2), 'saved human revision');
    const editedPlan = tasks(edited).find(t => t.id === fixture.task_id);
    assert.equal(editedPlan.goal, HUMAN_EDIT_GOAL);
    assert.deepEqual(editedPlan.steps.map(step => step.title), humanTitles);
    retainedPlan = editedPlan;
    await writeJson(path.join(output, 'plan-after-ui-save.json'), editedPlan);
    await shot('03-visible-human-edited-plan');
    receipt.human_plan_edit_exercised = true;
  } else {
    stage = 'fluorescence-source-and-result-views';
    await page.getByRole('button', { name: 'Close agent session drawer', exact: true }).click();
    const original = page.getByRole('button', { name: 'Original image', exact: true });
    await original.click();
    await wait(() => original.getAttribute('aria-pressed'), pressed => pressed === 'true', 'original source selection');
    await page.locator(`.image-viewport[data-viewer-source="${fixture.source_id}"][data-prepared="true"]`).waitFor();
    await shot('02-fluorescence-fixed-plane-source');
    const baseline = page.locator(`button[data-result-id="${fixture.baseline.result_id}"]`);
    await baseline.click();
    await wait(() => baseline.getAttribute('aria-pressed'), pressed => pressed === 'true', 'exact fixed-baseline result selection');
    await wait(() => page.locator('#research-image-stage').evaluate(element =>
      Boolean(element.querySelector('.image-viewport[data-result-overlay][data-prepared="true"]')) ||
      [...element.querySelectorAll('img[alt="Exact selected result revision"]')].some(image => image.complete && image.naturalWidth > 0)),
    ready => ready, 'rendered fluorescence baseline');
    await shot('03-fluorescence-fixed-baseline-result');
    receipt.checks.push({ check: 'public-fluorescence-view-artifacts', source_id: fixture.source_id,
      source_sha256: fixture.source_sha256, baseline: fixture.baseline,
      original_zero_based_z: prepared.provenance.zero_based_z, derived_axes: prepared.provenance.derived_axes,
      physical_calibration: prepared.provenance.physical_calibration,
      interpretation: 'Source-backed screenshots for independent visual interpretation; no accuracy claim' });
    await drawer();
  }

  stage = 'waiting-for-actual-host';
  await wait(async () => hostResult, value => value !== undefined, 'actual host completion', 1850000);
  await hostPromise;
  assert.equal(hostResult.code, 0, 'Actual host failed; preserve its original streams and attempt');
  const hostReceipt = await json(path.join(hostRoot, 'receipt.json'));
  const verification = await json(path.join(hostRoot, 'verification.json'));
  assert.equal(hostReceipt.status, 'passed-codex-host-engineering-qa');
  assert.equal(verification.execution_mode, 'codex-host');
  assert.equal(verification.case, prepared.case);
  assert.equal(verification.model_requested, 'gpt-6.1-sol');
  assert.equal(verification.model_observed, null);
  assert.equal(verification.human_review, false);
  receipt.host = { receipt_sha256: await sha(path.join(hostRoot, 'receipt.json')),
    verification_sha256: await sha(path.join(hostRoot, 'verification.json')),
    events_sha256: await sha(path.join(hostRoot, 'codex-events.jsonl')),
    session_id: verification.session_id, shutdown: verification.shutdown };

  stage = 'visible-assessment-and-evidence';
  const completed = await wait(snapshot, s => tasks(s).some(t => t.id === fixture.task_id && t.revision === expectedRevision && t.assessments.length === 1), 'saved assessment');
  const finalTask = tasks(completed).find(t => t.id === fixture.task_id);
  assert.deepEqual(finalTask, verification.task);
  assert.equal(finalTask.goal, expectedGoal);
  assert.deepEqual(finalTask.steps.map(step => step.title), expectedTitles);
  assert.deepEqual(finalTask.steps, retainedPlan.steps, 'Final plan must preserve exact retained steps');
  assert.deepEqual(finalTask.targets, retainedPlan.targets, 'Final plan must preserve exact retained evidence');
  assert.equal(finalTask.state, 'awaiting_review');
  assert.ok(completed.results.every(result => result.review == null), 'No result may acquire review authority');
  await drawer();
  const assessment = panel.getByRole('region', { name: 'Agent assessment', exact: true });
  await assessment.waitFor();
  assert.equal(await assessment.locator('.agent-task-prose').innerText(), finalTask.assessments[0].summary);
  assert.ok((await assessment.locator('.agent-task-limitations').innerText()).includes('Limitations'));
  const agreementJobs = completed.jobs.filter(job => job.owner?.session_id === verification.session_id && job.operation === 'annotation_evaluation_run');
  assert.equal(agreementJobs.length, 1);
  const report = completed.results.find(result => result.id === agreementJobs[0].result_ids[0]);
  assert.equal(report?.kind, 'annotation-agreement');
  assert.ok(finalTask.assessments[0].targets.some(t => t.kind === 'result' && t.id === report.id && t.revision_hash === report.revision_hash));
  await shot('04-visible-evidence-linked-assessment');
  await assessment.locator('.agent-task-evidence').scrollIntoViewIfNeeded();
  await shot('04b-assessment-limitations-and-evidence');
  await assessment.getByRole('button', { name: `Open result ${report.id}`, exact: true }).click();
  await page.locator(`button[data-result-id="${report.id}"][aria-pressed="true"]`).waitFor();
  if (await page.getByRole('button', { name: 'Close agent session drawer', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Close agent session drawer', exact: true }).click();
  await selectWorkbenchTool(page, 'Info');
  await selectResultSection(page, 'Review');
  const visibleReport = page.getByRole('region', { name: 'Saved annotation agreement', exact: true });
  await visibleReport.waitFor();
  const reportText = await visibleReport.innerText();
  assert.ok(reportText.includes(`${verification.oracle.intersection_pixels.toLocaleString()} shared`));
  assert.ok(reportText.includes('does not establish biological ground truth or accuracy'));
  await shot('05-exact-agreement-evidence-navigation');
  receipt.checks.push({ check: humanSync ? 'real-renderer-human-edit-stale-host-rejection-and-assessment'
    : 'real-renderer-authored-plan-and-assessment', task_id: finalTask.id,
    revision: finalTask.revision, plan_goal: finalTask.goal, step_titles: expectedTitles,
    human_plan_edit_exercised: humanSync, report: binding(report) });
  const reportRequest = { ...binding(report), table: 'summary' };
  const warmReport = await execute('annotation_evaluation_get', reportRequest);
  const warmJobs = completed.jobs.map(job => ({ id: job.id, operation: job.operation, state: job.state, result_ids: job.result_ids }));
  await closeApp();
  await waitOwnedExit('ordinary warm app and actual host shutdown');

  stage = 'cold-retained-reopen';
  const originalStudyHashes = await treeHashes(prepared.study);
  const coldStudy = path.join(output, 'cold-copy.loci-study');
  await fs.cp(prepared.study, coldStudy, { recursive: true, force: false, errorOnExist: true });
  const source = path.join(hostRoot, 'inputs/image.tif');
  const sourceSha = await sha(source);
  const offline = { source, hidden: `${source}.temporarily-offline-${path.basename(output)}`, sha256: sourceSha };
  assert.equal(await absent(offline.hidden), true);
  await fs.rename(source, offline.hidden);
  inputOffline = offline;
  assert.equal(await absent(source), true, 'Cold source must actually be absent');
  activeStudy = coldStudy;
  await launch(2);
  const cold = await openStudy();
  assert.equal(cold.project.project_id, receipt.project_id);
  assert.deepEqual(cold.jobs.map(job => ({ id: job.id, operation: job.operation, state: job.state, result_ids: job.result_ids })), warmJobs,
    'Cold reopening must not add or re-execute jobs');
  const coldTask = tasks(cold).find(t => t.id === fixture.task_id);
  assert.deepEqual(coldTask, finalTask, 'Cold task/assessment must retain exact authored provenance');
  const coldPanel = await drawer();
  await coldPanel.getByRole('region', { name: 'Agent assessment', exact: true }).waitFor();
  assert.equal(await coldPanel.locator('.agent-task-goal').innerText(), expectedGoal);
  assert.equal(await coldPanel.locator('.agent-task-assessment .agent-task-prose').innerText(), finalTask.assessments[0].summary);
  assert.deepEqual(await execute('annotation_evaluation_get', reportRequest), warmReport,
    'Cold exact report differs with prepared source absent');
  assert.deepEqual(await filesUnder(path.join(output, 'profile-2/models')), [], 'Cold model home is not empty');
  assert.equal(await absent(source), true);
  const afterCold = await snapshot();
  assert.deepEqual(afterCold.jobs.map(job => job.id), completed.jobs.map(job => job.id));
  assert.ok(afterCold.results.every(result => result.review == null));
  await page.getByRole('heading', { name: 'Image unavailable', exact: true }).waitFor();
  assert.equal(await page.getByText('Loading the selected source.', { exact: true }).count(), 0);
  await shot('06-cold-retained-plan-and-assessment');
  receipt.checks.push({ check: 'cold-retained-copy', source_absent: true, model_home_empty: true,
    decoder_instrumented: false, original_study_unmodified_by_cold_phase: true, task_id: finalTask.id,
    assessment_id: finalTask.assessments[0].id, jobs_unchanged: true, report: binding(report) });
  await closeApp();
  await waitOwnedExit('ordinary cold app shutdown');
  assert.deepEqual(await treeHashes(prepared.study), originalStudyHashes,
    'Cold phase must not mutate the original completed study');
  await fs.rename(inputOffline.hidden, inputOffline.source);
  assert.equal(await sha(inputOffline.source), inputOffline.sha256);
  inputOffline = undefined;
  assert.equal(await sha(path.join(hostRoot, 'prepared-fixture.json')), receipt.prepared_sha256);
  assert.deepEqual(await buildIdentity(), receipt.identity, 'App/worker identity changed during journey');
  const finalVerify = await exec(python, [harness, 'verify', '--output', hostRoot], { cwd: repo, timeout: 120000, maxBuffer: 16 * 1024**2 });
  await fs.writeFile(path.join(output, 'host-final-verification.json'), finalVerify.stdout);
  assert.equal(JSON.parse(finalVerify.stdout).status, 'passed-codex-host-engineering-qa');
  assert.deepEqual(receipt.renderer_errors, []);
  assert.deepEqual(receipt.network_requests, [], 'The desktop must remain local; Codex provider traffic is outside the renderer');
  receipt.status = 'passed-packaged-actual-host-task-workspace';
} catch (error) {
  failure = error;
  receipt.status = 'failed'; receipt.failure = { stage, message: error.message, stack: error.stack };
  if (page) await shot('failure').catch(() => {});
} finally {
  clearInterval(tick);
  await scan.catch(() => {});
  if (failure) await stopHostOnFailure().catch(error => { receipt.host_cleanup_error = error.message; });
  await closeApp().catch(error => { failure ??= error; receipt.app_cleanup_error = error.message; });
  const cleaned = await cleanupOwned().catch(error => { failure ??= error; receipt.process_cleanup_error = error.message; });
  if (!failure && cleaned?.survivors_before_cleanup.length) {
    failure = new Error('Ordinary completion required forced process cleanup');
    receipt.process_cleanup_error = failure.message;
  }
  if (inputOffline) {
    try {
      assert.equal(await absent(inputOffline.source), true, 'Refuse overwriting source created during cold phase');
      await fs.rename(inputOffline.hidden, inputOffline.source);
      assert.equal(await sha(inputOffline.source), inputOffline.sha256);
    } catch (error) { failure ??= error; receipt.source_restore_error = error.message; }
  }
  await Promise.all(hostStreams.map(stream => new Promise(resolve => stream.end(resolve))));
  if (failure) receipt.status = 'failed';
  receipt.finished_at = new Date().toISOString();
  await writeJson(receiptPath, receipt);
}
process.stdout.write(JSON.stringify({ output, status: receipt.status, receipt: receiptPath }) + '\n');
if (failure) throw failure;
