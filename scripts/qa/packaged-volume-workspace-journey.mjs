/** Lead-run packaged 3D object journey. Never executed by fixture preparation.
 * Requires Node24, LOCI_PACKAGED_APP, LOCI_QA_PYTHON, LOCI_QA_OUTPUT_ROOT,
 * LOCI_QA_VOLUME_FIXTURE and LOCI_QA_SOURCE_COMMIT. All paths must be absolute.
 * Set LOCI_QA_NATIVE_LABEL_PICKER=1 to retain the ordinary OS label dialog;
 * select the prepared labels.tif manually. Other pickers are declared simulations.
 * No new bridge, hidden scene controls, model, download, install or build.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { createEmptyStudy, fileMenuAction, revealExternalLabels, selectWorkbenchTool, setSelectionField, waitForSnapshot } from '../../desktop/tests/workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..'), require = createRequire(path.join(repo, 'desktop/package.json'));
const { _electron: electron } = require('playwright'), exec = promisify(execFile), env = process.env;
assert.equal(process.platform, 'darwin'); assert.equal(process.versions.node.split('.')[0], '24');
const required = name => { assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be absolute`); return env[name]; };
const bundle = required('LOCI_PACKAGED_APP'), python = required('LOCI_QA_PYTHON');
const fixturePath = required('LOCI_QA_VOLUME_FIXTURE'), fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
assert.equal(fixture.schema, 'loci.volume-workspace-fixture/v1'); assert.equal(fixture.phase, 'prepared-not-executed');
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/u);
const output = await fs.mkdtemp(path.join(required('LOCI_QA_OUTPUT_ROOT'), 'packaged-volume-workspace-'));
const study = path.join(output, 'Workspace.loci-study'), executable = path.join(bundle, 'Contents/MacOS/Loci');
const oracle = path.join(repo, 'scripts/qa_volume_workspace.py'), nativeLabels = env.LOCI_QA_NATIVE_LABEL_PICKER === '1';
const hash = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const report = { schema: 'loci.packaged-volume-workspace-qa/v1', status: 'running', output, case: fixture.case,
  started_at: new Date().toISOString(), source_commit: env.LOCI_QA_SOURCE_COMMIT,
  fixture: { path: fixturePath, sha256: await hash(fixturePath) }, build: {}, checks: [], dialogs: [], captures: [], page_errors: [], console_errors: [], network_requests: [], processes: [],
  limits: ['Engineering acceptance, not biological accuracy, independent animals, human scientific review or actual Codex-host acceptance.',
    'Open/create/source pickers are simulated in main; all adoption uses real preload/main/packaged worker.',
    nativeLabels ? 'Label picker uses the ordinary OS dialog and requires manual choice of the prepared TIFF.' : 'Label picker response is explicitly simulated; ordinary OS picker qualification remains separate.',
    'CellSeg3D axes and unsigned conversion are explicit derived declarations; physical calibration remains absent.',
    'Kidney labels are authored technical geometry on biological raw pixels, not reference cell annotations.'] };
for (const [name, file] of Object.entries({ executable, asar: path.join(bundle, 'Contents/Resources/app.asar'), worker: path.join(bundle, 'Contents/Resources/loci-engine/loci-engine') })) report.build[name + '_sha256'] = await hash(file);
report.build.identity = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/loci-build-identity.json'), 'utf8'));
assert.equal(report.build.identity.sourceRevision, env.LOCI_QA_SOURCE_COMMIT, 'The requested source revision must identify the actual packaged app');
report.harness_sha256 = await hash(import.meta.filename); report.oracle_sha256 = await hash(oracle);
let app, page, source, parent, child, failure;
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
const scene = () => execute('volume_view', { source_id: source.id });
async function wait(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    for (const alert of await page.locator('.research-alert[role="alert"], .volume-workspace-message[role="alert"]').all()) if (await alert.isVisible()) throw new Error(`${label}: ${await alert.textContent()}`);
    const sceneError = page.getByRole('status').filter({ hasText: /^Shared 3D view:/u });
    if (await sceneError.count()) throw new Error(`${label}: ${await sceneError.textContent()}`);
    last = await read(); if (accept(last)) return last; await page.waitForTimeout(100);
  }
  throw new Error(`${label}: timed out; ${JSON.stringify(last)}`);
}
async function shot(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' }); report.captures.push({ name, sha256: await hash(file) }); }
async function launch(number) {
  const profile = path.join(output, 'profile-' + number);
  app = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], cwd: path.join(repo, 'desktop'), timeout: 120000,
    env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.page_errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.console_errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/u.test(request.url())) report.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow, dialog, screen }, paths) => {
    const display = screen.getPrimaryDisplay(), w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: display.workArea.x + 15, y: display.workArea.y + 15, width: Math.min(1440, display.workArea.width - 30), height: Math.min(1000, display.workArea.height - 30) }); w.show();
    globalThis.__volumeQaDialogs = [];
    const ordinary = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const isLabels = /^Import labels on this (plane|volume)$/u.test(title ?? '');
      const file = isLabels ? paths.labels : title === 'Open research study' ? paths.study : title === 'Add microscopy or medical images' ? paths.source : null;
      if (!file) throw new Error('Unexpected open picker: ' + title);
      let answer;
      if (isLabels && paths.nativeLabels) answer = await ordinary(...args);
      else answer = { canceled: false, filePaths: [file] };
      globalThis.__volumeQaDialogs.push({ title, simulated: !(isLabels && paths.nativeLabels), canceled: answer.canceled, selected_basenames: answer.filePaths.map(p => p.split('/').at(-1)) });
      return answer;
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Create research study') throw new Error('Unexpected save picker: ' + title);
      globalThis.__volumeQaDialogs.push({ title, simulated: true });
      return { canceled: false, filePath: paths.study };
    };
    dialog.showMessageBox = async (...args) => { throw new Error('Unexpected confirmation: ' + args.at(-1)?.message); };
  }, { study, source: fixture.source.path, labels: fixture.labels.path, nativeLabels });
  await page.waitForFunction(() => Boolean(window.lociResearch));
  await page.locator('main.image-first-empty, main.image-first-workbench').waitFor({ timeout: 120000 });
}
async function close() {
  if (!app) return;
  report.dialogs.push(...await app.evaluate(() => globalThis.__volumeQaDialogs ?? []));
  const readProcesses = async () => {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000 });
    return new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
      const fields = line.trim().split(/\s+/u); return [Number(fields[0]), { parent: Number(fields[1]), start: fields.slice(2).join(' ') }];
    }));
  };
  const before = await readProcesses(), owned = new Set([app.process().pid]);
  for (;;) { const count = owned.size; for (const [pid, value] of before) if (owned.has(value.parent)) owned.add(pid); if (count === owned.size) break; }
  const identities = [...owned].filter(pid => before.has(pid)).map(pid => ({ pid, start: before.get(pid).start }));
  const current = app, stopped = current.waitForEvent('close', { timeout: 30000 });
  let quitError;
  try { await current.evaluate(({ app }) => app.quit()); await stopped; }
  catch (error) { quitError = error; }
  finally { app = undefined; page = undefined; await current.close().catch(() => {}); }
  let rows = await readProcesses(), survivors = identities.filter(p => rows.get(p.pid)?.start === p.start);
  for (let attempt = 0; attempt < 20 && survivors.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100)); rows = await readProcesses(); survivors = identities.filter(p => rows.get(p.pid)?.start === p.start);
  }
  const entry = { scope: 'Identity-pinned descendant inventory immediately before quit; no continuous process tracing', observed: identities, survivors_after_quit: survivors };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const p of survivors) if ((await readProcesses()).get(p.pid)?.start === p.start) try { process.kill(p.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (survivors.length) await new Promise(resolve => setTimeout(resolve, 300));
    rows = await readProcesses(); survivors = identities.filter(p => rows.get(p.pid)?.start === p.start);
  }
  entry.final_survivors = survivors; report.processes.push(entry);
  assert.deepEqual(survivors, [], 'Owned app descendants survived cleanup');
  assert.deepEqual(entry.survivors_after_quit, [], 'Ordinary app shutdown required forced cleanup');
  if (quitError) throw quitError;
}
async function chooseResult(result) {
  await page.locator(`button[data-source-id="${result.source_id}"]`).click();
  await page.locator(`button[data-result-id="${result.id}"]`).click();
  await page.locator(`button[data-result-id="${result.id}"][aria-pressed="true"]`).waitFor();
}
async function openVolume() {
  const button = page.getByRole('button', { name: '3D volume', exact: true });
  if (await button.isVisible()) await button.click();
  await wait(() => scene(), value => value.state?.result?.result_id === parent.id && value.state.result.revision_hash === parent.revision_hash, 'exact result scene saved', 120000);
  await page.getByRole('region', { name: 'Volume labels and selection', exact: true }).getByLabel('Labels', { exact: true }).check();
  await wait(() => scene(), value => value.state?.labels.visible, 'labels enabled');
}
async function range(label, value) {
  const field = page.getByLabel(label, { exact: true });
  const min = Number(await field.getAttribute('min')), max = Number(await field.getAttribute('max'));
  assert.ok(value >= min && value <= max, `${label} must stay inside its native range`);
  // Set the actual input and dispatch its normal React event; keyboard Home is
  // not reliable across macOS range controls or inactive app windows.
  await field.evaluate((input, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native range setter unavailable');
    setter.call(input, String(next)); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  assert.equal(Number(await field.inputValue()), value);
}
const selected = value => value.state?.selected_object?.label_id === fixture.target_label && value.state.selected_object.result_id === parent.id && value.state.selected_object.revision_hash === parent.revision_hash;
async function targetFromTable() {
  await selectWorkbenchTool(page, 'Population');
  const entry = page.getByLabel('Go to object label', { exact: true }); await entry.fill(String(fixture.target_label)); await entry.press('Enter');
  await wait(() => scene(), selected, 'exact table selection');
  await page.locator(`tr[data-label="${fixture.target_label}"][aria-selected="true"]`).waitFor();
}
async function clearObjectSelection() {
  const clear = page.getByRole('button', { name: 'Clear object selection', exact: true });
  if (await clear.isVisible()) await clear.click();
  return wait(() => scene(), value => value.state?.selected_object === null, 'cleared selection saved before a new pick');
}
async function selectMpr() {
  await page.getByRole('button', { name: 'Four panes', exact: true }).click();
  for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
    await range(axis + ' slice', fixture.probe_source_xyz[i]);
  }
  const [x, y, z] = fixture.probe_source_xyz, [nx, ny, nz] = fixture.source_dimensions_xyz;
  for (const [plane, u, v] of [['XY plane', x / (nx - 1), y / (ny - 1)], ['XZ plane', x / (nx - 1), 1 - z / (nz - 1)], ['YZ plane', y / (ny - 1), 1 - z / (nz - 1)]]) {
    await clearObjectSelection();
    const canvas = page.getByRole('region', { name: plane + ' view', exact: true }).getByLabel(plane + ' resliced image', { exact: true });
    const b = await canvas.boundingBox(); assert.ok(b);
    const beforeCamera = (await scene()).state.camera;
    await page.mouse.click(b.x + u * b.width, b.y + v * b.height);
    const picked = await wait(() => scene(), selected, 'native sparse label picked in ' + plane);
    assert.deepEqual(picked.state.camera, beforeCamera, 'MPR selection must preserve the researcher camera');
    report.checks.push({ route: plane, selected_label: fixture.target_label, normalized_pointer: [u, v] });
  }
}
const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => a.map(n => n / Math.hypot(...a));
async function select3d() {
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await wait(() => scene(), v => v.state?.layout.mode === 'single' && v.state.camera, 'saved 3D camera');
  // Clearing the selection changes the controls' height. Resolve the canvas
  // bounds and camera only after that layout/state change has committed.
  const view = await clearObjectSelection();
  const c = view.state.camera, p = [...fixture.probe_source_xyz, 1]; p[2] -= fixture.selection.z;
  const world = fixture.affine.slice(0, 3).map(row => dot(row, p));
  const forward = norm(c.focal_point_xyz.map((n, i) => n - c.position_xyz[i]));
  const right = norm(cross(forward, c.view_up_xyz)), up = cross(right, forward), delta = world.map((n, i) => n - c.position_xyz[i]);
  const canvas = page.locator('.raw-volume-stage canvas').first(), b = await canvas.boundingBox(); assert.ok(b);
  const half = c.projection === 'parallel' ? c.parallel_scale : dot(delta, forward) * Math.tan(c.view_angle_degrees * Math.PI / 360);
  const u = .5 + dot(delta, right) / (2 * half * b.width / b.height), v = .5 - dot(delta, up) / (2 * half);
  assert.ok(u > 0 && u < 1 && v > 0 && v < 1, 'Known object must project into the real 3D canvas');

  await page.mouse.click(b.x + u * b.width, b.y + v * b.height);
  const picked = await wait(() => scene(), selected, 'exact voxel ray selected in 3D');
  assert.deepEqual(picked.state.camera, c, '3D picking must preserve the researcher camera');
  report.checks.push({ route: 'actual 3D canvas pointer', selected_label: fixture.target_label, world, normalized_pointer: [u, v] });
}
async function verifyArrays() {
  const args = [oracle, 'verify', '--fixture', fixturePath, '--study', study, '--parent', parent.id]; if (child) args.push('--child', child.id);
  const value = await exec(python, args, { cwd: repo, timeout: 60000, maxBuffer: 4 * 1024**2 }); report.array_oracle = JSON.parse(value.stdout);
}
try {
  assert.equal(await hash(fixture.source.path), fixture.source.sha256); assert.equal(await hash(fixture.labels.path), fixture.labels.sha256);
  await launch(1); await createEmptyStudy(page);
  await page.locator('main.image-first-workbench').waitFor();
  await page.getByRole('button', { name: 'Add images…', exact: true }).click();
  const imported = await waitForSnapshot(page, s => s.sources.length === 1, 'native source import', 120000); source = imported.sources[0]; assert.equal(source.sha256, fixture.source.sha256);
  await selectWorkbenchTool(page, 'Display'); await page.getByLabel('Display scope').selectOption('max'); await page.getByLabel('Analysis depth').selectOption('volume');
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['Z', 'z'], ['Z stop', 'z_stop'], ['T', 't']]) await setSelectionField(page, label, fixture.selection[key]);
  await selectWorkbenchTool(page, 'Analyze'); await page.getByLabel('Segmentation input', { exact: true }).selectOption(String(fixture.selection.c));
  await revealExternalLabels(page);
  const memoryEstimate = page.locator('.recipe-resources summary strong');
  const waitMemory = label => wait(() => memoryEstimate.innerText(), value => /^\d[\d,.]* (?:MiB|GiB)$/u.test(value), label);
  const memoryBeforePicker = await waitMemory('recipe estimate before native label picker');
  await page.getByRole('button', { name: 'Import labels', exact: true }).click();
  if (nativeLabels) {
    console.log('NATIVE_LABEL_CANCEL_READY');
    await wait(() => app.evaluate(() => globalThis.__volumeQaDialogs.filter(d => /^Import labels/.test(d.title))), v => v.length === 1, 'ordinary label picker cancellation', 120000);
    const cancelled = await app.evaluate(() => globalThis.__volumeQaDialogs.at(-1));
    assert.equal(cancelled.simulated, false); assert.equal(cancelled.canceled, true);
    assert.equal((await snapshot()).results.length, 0, 'Cancelling the picker must not create a result');
    const restoredEstimate = await waitMemory('recipe estimate automatically restored after picker cancellation');
    assert.equal(restoredEstimate, memoryBeforePicker);
    report.checks.push({ route: 'native picker cancellation memory estimate recovery', estimate: restoredEstimate });
    await page.getByRole('button', { name: 'Import labels', exact: true }).click();
    console.log('NATIVE_LABEL_SELECT_READY');
  }
  await page.getByAltText(/Checked label overlay on the volume/u).waitFor({ timeout: nativeLabels ? 120000 : 30000 });
  assert.equal(await waitMemory('recipe estimate restored after label preview'), memoryBeforePicker);
  await page.getByRole('button', { name: 'Import on this volume', exact: true }).click();
  parent = (await waitForSnapshot(page, s => s.results.length === 1, 'actual volume label adoption', 120000)).results[0];
  assert.equal(parent.label_import.profile, 'scalar-native-zyx/v1'); assert.deepEqual(parent.selection, fixture.selection); assert.equal(parent.object_count, fixture.rows.length); assert.equal(parent.review, null);
  await verifyArrays(); await openVolume();
  const beforeTable = (await scene()).state.camera; await targetFromTable(); assert.deepEqual((await scene()).state.camera, beforeTable);
  await selectMpr(); await shot('01-linked-mpr-object'); await select3d(); await shot('02-native-3d-object');
  const labelControls = page.getByRole('region', { name: 'Volume labels and selection', exact: true });
  await labelControls.getByLabel('Selected only', { exact: true }).check(); await range('Label opacity', 70);
  await wait(() => scene(), v => selected(v) && v.state.labels.selected_only && v.state.labels.opacity === .7, 'label presentation controls persisted');
  await page.locator('details.raw-volume-rendering-detail > summary').click();
  await page.getByLabel('Clip', { exact: true }).check();
  await wait(() => scene(), v => v.state?.clipping.enabled, 'clipping state persisted independently of selection');
  await page.locator('details.raw-volume-rendering-detail > summary').click();
  const beforeLocate = await scene(); await page.getByRole('button', { name: 'Locate object', exact: true }).click();
  const located = await wait(() => scene(), v => selected(v) && v.revision > beforeLocate.revision, 'explicit locate persisted');
  const targetRow = fixture.rows.find(r => r.label === fixture.target_label);
  const localCenter = [2, 1, 0].map(i => Math.round((targetRow.bbox_start[i] + targetRow.bbox_stop_exclusive[i] - 1) / 2));
  const expectedSource = localCenter.map((n, i) => n + (i === 2 ? fixture.selection.z : 0));
  assert.deepEqual(located.state.crosshair_source_xyz, expectedSource, 'Only explicit Locate recenters the inspected object');
  const near = (actual, expected, label) => { assert.equal(actual.length, expected.length); actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) <= 1e-8, `${label}: ${n} != ${expected[i]}`)); };
  const oldCamera = beforeLocate.state.camera, newCamera = located.state.camera;
  near(newCamera.focal_point_xyz, fixture.affine.slice(0, 3).map(row => dot(row, [...localCenter, 1])), 'located world center');
  near(newCamera.position_xyz.map((n, i) => n - newCamera.focal_point_xyz[i]), oldCamera.position_xyz.map((n, i) => n - oldCamera.focal_point_xyz[i]), 'camera view vector');
  for (const key of ['projection', 'view_up_xyz', 'view_angle_degrees', 'parallel_scale']) assert.deepEqual(newCamera[key], oldCamera[key], 'Explicit Locate preserves ' + key);
  assert.deepEqual(located.state.clipping, beforeLocate.state.clipping);
  report.checks.push({ route: 'selection and explicit locate', selection_camera_preserved: true, explicit_locate_translation_verified: true, view_orientation_and_zoom_preserved: true, clipping_controls_preserved: true });
  const retained = located.state; report.retained_scene = located; await close();
  await launch(2); await fileMenuAction(page, 'Open study'); await waitForSnapshot(page, s => s?.results.some(r => r.id === parent.id) === true, 'fresh profile reopen', 120000);
  await chooseResult(parent); await openVolume();
  const reopened = await wait(() => scene(), v => JSON.stringify(v.state) === JSON.stringify(retained), 'exact cold-reopened scene state', 120000);
  report.reopened_scene = reopened; await shot('03-reopened-object-scene');
  await page.getByRole('button', { name: 'Correct', exact: true }).click(); await page.getByLabel('Correction label', { exact: true }).waitFor();
  await wait(() => page.getByLabel('Correction label', { exact: true }).inputValue(), v => Number(v) === fixture.target_label, 'connected exact correction label');
  await page.getByRole('button', { name: 'Delete selected label', exact: true }).click();
  child = (await waitForSnapshot(page, s => s.results.some(r => r.parent_id === parent.id), 'immutable corrected child', 120000)).results.find(r => r.parent_id === parent.id);
  assert.equal(child.review, null); await verifyArrays(); await shot('04-corrected-child');
  report.checks.push({ route: 'connected delete correction', parent_id: parent.id, child_id: child.id, exact_remeasurement: true });
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); assert.deepEqual(report.network_requests, []);
  const labelDialogs = report.dialogs.filter(d => /^Import labels on this (plane|volume)$/u.test(d.title));
  assert.equal(labelDialogs.length, nativeLabels ? 2 : 1);
  assert.deepEqual(labelDialogs.map(d => d.canceled), nativeLabels ? [true, false] : [false]);
  assert.ok(labelDialogs.every(d => d.simulated === !nativeLabels));
  report.parent = parent; report.child = child; report.study = study; report.status = 'passed-packaged-engineering';
} catch (error) {
  failure = error; report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; if (page) await shot('failure').catch(() => {});
} finally {
  try { await close(); } catch (error) { report.close_error = error.message; report.status = 'failed'; failure ??= error; }
  report.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ output, status: report.status, receipt: path.join(output, 'receipt.json') }));
if (failure) throw failure;
