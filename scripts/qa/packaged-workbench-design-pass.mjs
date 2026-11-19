/** Workbench design acceptance on a clean, explicitly identified packaged macOS candidate.
 * Set LOCI_PACKAGED_APP, LOCI_QA_PYTHON, LOCI_QA_OUTPUT_ROOT (absolute paths),
 * LOCI_QA_SOURCE_COMMIT (embedded SHA), and optionally LOCI_QA_SECONDARY_DISPLAY
 * (exact Electron display ID/label). Run with Node 24. No downloads or lab inputs.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { placeQaWindow } from './display-placement.mjs';
import { closeSettings, openSettings } from '../../desktop/tests/settings-qa-helpers.mjs';
import { fileMenuAction, selectWorkbenchTool, waitForSnapshot } from '../../desktop/tests/workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const desktop = path.join(repo, 'desktop');
const env = process.env;
const exec = promisify(execFile);
const require = createRequire(path.join(desktop, 'package.json'));
const { _electron: electron } = require('playwright');
assert.equal(process.platform, 'darwin', 'Packaged macOS only');
assert.equal(process.versions.node.split('.')[0], '24', 'Use supported Node 24');
const absolute = name => {
  assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be absolute`);
  return env[name];
};
const bundle = absolute('LOCI_PACKAGED_APP');
const python = absolute('LOCI_QA_PYTHON');
const outputRoot = absolute('LOCI_QA_OUTPUT_ROOT');
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/u);
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, 'packaged-workbench-design-'));
const artifactPaths = {
  executable: path.join(bundle, 'Contents/MacOS/Loci'),
  asar: path.join(bundle, 'Contents/Resources/app.asar'),
  worker: path.join(bundle, 'Contents/Resources/loci-engine/loci-engine'),
  identity: path.join(bundle, 'Contents/Resources/loci-build-identity.json'),
};
const fixtureHelper = path.join(repo, 'scripts/qa/agent-session-client.py');
const fixtureGenerator = path.join(repo, 'scripts/qa/agent-workbench-client.py');
const profiles = ['graphite', 'paper', 'black'].flatMap(theme => ['compact', 'comfortable'].map(density => ({ theme, density })));
const sizes = [[1024, 720], [1280, 800], [1440, 900], [1920, 1080]];
const groups = ['View', 'Annotate', 'Analyze', 'Results'];
const report = {
  schema: 'loci.packaged-workbench-design-qa/v1', status: 'running', stage: 'identity',
  started_at: new Date().toISOString(), source_commit: env.LOCI_QA_SOURCE_COMMIT, output,
  captures: [], resizes: [], checks: [], dialogs: [], page_errors: [], console_errors: [], network_requests: [],
  limits: ['Authored synthetic image and known object areas. Software presentation evidence only.',
    'The stock macOS image chooser response is simulated with the generated fixture.',
    'The stock macOS study chooser responses are simulated with two source-free synthetic studies. No SSH operation is requested.',
    'Each renderer viewport records native or CDP placement. The 200% check uses Electron page zoom on the actual display.'],
};
let app, page, cdp, display, fixture, source, result;
const save = () => fs.writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`);
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function artifactHashes() {
  return Object.fromEntries(await Promise.all(Object.entries(artifactPaths).map(async ([key, file]) => [key, await sha256(file)])));
}
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const viewport = () => page.evaluate(() => ({
  width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density,
}));
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const sourcePane = () => page.locator('.research-sources-pane');
const toolHeader = () => page.locator('.research-tool-header');
const table = () => page.getByRole('region', { name: 'Result measurements', exact: true });

async function capture(name, geometry = null, { nativeZoom = false } = {}) {
  await paint();
  const file = `${name}.png`;
  const target = path.join(output, file);
  const frame = await viewport();
  let png, native;
  if (nativeZoom) {
    // Playwright's CSS screenshot scaling divides by the zoom multiplier on top
    // of the display scale. Capture the real Electron content bitmap instead.
    const { png_base64, ...captureInfo } = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.webContents;
      const image = await contents.capturePage();
      if (image.isEmpty()) throw new Error('The native zoom capture is empty');
      const scales = image.getScaleFactors();
      const scale = Math.max(1, ...scales);
      return { window_content_dip: window.getContentSize(), display_scale: screen.getDisplayMatching(window.getBounds()).scaleFactor,
        zoom_factor: contents.getZoomFactor(), image_scales: scales, png_base64: image.toPNG({ scaleFactor: scale }).toString('base64') };
    });
    native = captureInfo;
    png = Buffer.from(png_base64, 'base64');
    await fs.writeFile(target, png);
  } else {
    png = await page.screenshot({ path: target, animations: 'disabled', scale: 'css' });
  }
  assert.ok(png.length > 2000, `${name}: capture has little visible content`);
  const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (native) {
    assert.ok(Math.abs(native.zoom_factor - 2) < 1e-9, `${name}: frame was not captured at actual Electron 200% zoom`);
    const logical = [frame.width, frame.height];
    assert.ok(logical.every((dimension, i) => Math.abs(dimension * native.zoom_factor - native.window_content_dip[i]) <= 2),
      `${name}: CSS viewport did not match the zoomed native window content`);
    const pngScale = [1, native.display_scale, ...native.image_scales].find(scale => native.window_content_dip.every((dimension, i) =>
      Math.abs(dimension * scale - size[i]) <= 1));
    assert.ok(pngScale, `${name}: ${size.join('×')} bitmap did not cover the ${native.window_content_dip.join('×')} native window content`);
    native.png_pixels_per_dip = pngScale;
  } else {
    assert.deepEqual(size, [frame.width, frame.height], `${name}: PNG dimensions do not match the checked CSS viewport`);
  }
  report.captures.push({ name, file, size, sha256: createHash('sha256').update(png).digest('hex'), frame, geometry,
    capture_mode: native ? 'electron-native-content-bitmap' : 'playwright-css-viewport', ...(native ? { native } : {}) });
}

async function resize(width, height, stage) {
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const native = await app.evaluate(({ BrowserWindow, screen }, request) => {
    const window = BrowserWindow.getAllWindows()[0];
    const display = screen.getAllDisplays().find(item => item.id === request.displayId);
    if (!display) throw new Error('The selected QA display disconnected');
    const { width: outerWidth, height: outerHeight } = window.getBounds();
    const [contentWidth, contentHeight] = window.getContentSize();
    const frameWidth = outerWidth - contentWidth;
    const frameHeight = outerHeight - contentHeight;
    const area = display.workArea;
    const fits = request.width + frameWidth <= area.width && request.height + frameHeight <= area.height;
    if (fits) {
      window.setPosition(area.x, area.y);
      window.setContentSize(request.width, request.height);
    }
    const bounds = window.getBounds();
    return { fits, bounds, content: window.getContentSize(), work_area: area,
      display_id: screen.getDisplayMatching(bounds).id };
  }, { width, height, displayId: display.id });
  assert.equal(native.display_id, display.id, 'QA resize moved the window to a different display');
  await paint();
  const before = await viewport();
  const emulated = !native.fits || native.content[0] !== width || native.content[1] !== height || before.width !== width || before.height !== height;
  if (emulated) await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false,
  });
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  report.resizes.push({ stage, requested: [width, height], native, before, actual: await viewport(),
    mode: emulated ? 'renderer-viewport-emulated-via-CDP' : 'native-content-resize' });
}

async function appearance({ theme, density }) {
  const settings = await openSettings(app, page, { requireNative: true });
  const { dialog } = settings;
  await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Application theme', exact: true }).selectOption(theme);
  const label = density === 'compact' ? 'Compact' : 'Comfortable';
  await dialog.getByRole('radiogroup', { name: 'Workbench density', exact: true }).getByRole('radio', { name: label, exact: true }).click();
  for (const surface of [page, settings.page]) {
    await surface.waitForFunction(({ theme, density }) => document.documentElement.dataset.theme === theme &&
      document.documentElement.dataset.density === density, { theme, density });
  }
  if (theme === 'black') {
    const rgba = await page.evaluate(() => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
      if (!CSS.supports('color', color)) throw new Error('The canvas background must resolve to a colour');
      const context = document.createElement('canvas').getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.deepEqual(rgba, [0, 0, 0, 255], 'Black uses an opaque, true black image surround');
  }
  await closeSettings(settings);
}

async function nativeWindowId(surface) {
  const handle = await app.browserWindow(surface);
  try { return await handle.evaluate(window => window.id); }
  finally { await handle.dispose(); }
}

async function auditNativeSettingsZoom({ page: settingsPage, dialog }) {
  const settingsWindow = await app.browserWindow(settingsPage);
  const mainWindow = await app.browserWindow(page);
  const readZoom = window => window.evaluate(native => native.webContents.getZoomFactor());
  const setZoom = (window, factor) => window.evaluate((native, value) => {
    native.webContents.setZoomFactor(value);
    return native.webContents.getZoomFactor();
  }, factor);
  try {
    const settingsZoom = await readZoom(settingsWindow);
    const mainZoom = await readZoom(mainWindow);
    const baseline = await settingsPage.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    try {
      assert.ok(Math.abs(await setZoom(settingsWindow, 2) - 2) < 1e-9, 'Settings must use true Electron 200% zoom');
      await settingsPage.waitForFunction(({ width, height, dpr, ratio }) =>
        Math.abs(innerWidth * ratio - width) <= 2 && Math.abs(innerHeight * ratio - height) <= 2 &&
        Math.abs(devicePixelRatio / dpr - ratio) < 0.02, { ...baseline, ratio: 2 / settingsZoom });
      const search = dialog.getByRole('searchbox', { name: 'Search settings', exact: true });
      await search.click();
      await search.fill('Workbench density');
      await dialog.getByRole('button', { name: /^Workbench density\b/ }).waitFor();
      const zoomed = await search.evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const root = document.documentElement;
        const shell = element.closest('.settings-shell');
        const pane = shell.querySelector('.settings-pane');
        return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
          page_overflow_x: root.scrollWidth - root.clientWidth,
          settings_overflow_x: shell.scrollWidth - shell.clientWidth,
          pane_overflow_x: pane.scrollWidth - pane.clientWidth,
          search: { x, y, width, height, focused: element === document.activeElement,
            hit: document.elementFromPoint(x + width / 2, y + height / 2) === element } };
      });
      assert.ok(zoomed.page_overflow_x <= 1 && zoomed.settings_overflow_x <= 1 && zoomed.pane_overflow_x <= 1,
        `Settings overflows horizontally at 200% zoom: ${JSON.stringify(zoomed)}`);
      assert.ok(zoomed.search.focused && zoomed.search.hit, 'Settings search must remain reachable at 200% zoom');
      await search.press('Escape');
      assert.equal(await search.inputValue(), '');
      return { factor: 2, baseline, zoomed };
    } finally {
      await setZoom(settingsWindow, settingsZoom);
      if (Math.abs(await readZoom(mainWindow) - mainZoom) > 1e-9) await setZoom(mainWindow, mainZoom);
      assert.ok(Math.abs(await readZoom(settingsWindow) - settingsZoom) < 1e-9 &&
        Math.abs(await readZoom(mainWindow) - mainZoom) < 1e-9, 'Settings and workspace must recover their prior Electron zoom');
      await settingsPage.waitForFunction(({ width, height, dpr }) => innerWidth === width && innerHeight === height &&
        Math.abs(devicePixelRatio - dpr) < 0.02, baseline);
    }
  } finally {
    await Promise.all([settingsWindow.dispose(), mainWindow.dispose()]);
  }
}

async function auditNativeSettings() {
  await selectWorkbenchTool(page, 'Analyze');
  const before = await viewport();
  await appearance({ theme: 'graphite', density: 'compact' });
  const getStudyBinding = () => page.evaluate(async ({ sourceId, resultId }) => {
    const snapshot = await window.lociResearch.getSnapshot();
    const source = snapshot.sources.find(item => item.id === sourceId);
    const result = snapshot.results.find(item => item.id === resultId);
    return { project: snapshot.project.project_id, source: source?.sha256, result: result?.revision_hash,
      labels: result?.arrays.labels.sha256, selection: result?.selection, review: result?.review ?? null };
  }, { sourceId: source.id, resultId: result.id });
  const binding = await getStudyBinding();
  assert.equal(binding.source, fixture.sha256);
  assert.equal(binding.result, result.revision_hash);
  assert.equal(binding.labels, result.arrays.labels.sha256);

  const settings = await openSettings(app, page, { requireNative: true });
  const { page: settingsPage, dialog } = settings;
  const initialId = await nativeWindowId(settingsPage);
  assert.notEqual(initialId, await nativeWindowId(page));
  assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0);
  const isolation = await settingsPage.evaluate(() => ({
    settings: typeof window.lociSettings, desktop: typeof window.loci, research: typeof window.lociResearch,
    images: typeof window.lociImageWindows, agent: typeof window.lociAgentWorkspace, node: typeof window.require,
  }));
  assert.deepEqual(isolation, { settings: 'object', desktop: 'undefined', research: 'undefined',
    images: 'undefined', agent: 'undefined', node: 'undefined' });
  await dialog.getByRole('tab', { name: 'Saving & export', exact: true }).click();
  const dpi = dialog.getByRole('textbox', { name: 'Default figure DPI' });
  const savedDpi = await dpi.inputValue();
  await dpi.fill('1201');
  await dpi.press('Tab');
  await dpi.and(dialog.locator('[aria-invalid="true"]')).waitFor();
  const singleton = await openSettings(app, page, { requireNative: true });
  assert.equal(await nativeWindowId(singleton.page), initialId, 'Repeated Settings opens must focus the same window');
  assert.equal(app.windows().length, 2, 'Exactly one Settings window can coexist with the workbench');
  assert.equal(await dpi.inputValue(), '1201', 'Focusing Settings must preserve its invalid draft');

  const compute = await openSettings(app, page, { requireNative: true, trigger: button('Compute setup') });
  assert.equal(await nativeWindowId(compute.page), initialId, 'Compute setup must route the existing Settings window');
  await dialog.getByRole('tab', { name: 'Compute', exact: true }).and(dialog.locator('[aria-selected="true"]')).waitFor();
  await dialog.getByRole('tab', { name: 'Saving & export', exact: true }).click();
  assert.equal(await dpi.inputValue(), '1201');
  await dpi.press('Escape');
  assert.equal(await dpi.inputValue(), savedDpi);
  await dialog.getByRole('tab', { name: 'User guide', exact: true }).click();
  await button('Open user guide', dialog).click();
  const manual = settingsPage.getByRole('dialog', { name: 'User manual', exact: true });
  await manual.waitFor();
  assert.equal(await dialog.isVisible(), false, 'The guide replaces Settings in the dedicated window');
  await button('Close user manual', manual).click();
  await dialog.getByRole('tab', { name: 'User guide', exact: true }).and(dialog.locator('[aria-selected="true"]')).waitFor();

  await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await dialog.getByRole('radiogroup', { name: 'Theme previews', exact: true }).getByRole('radio', { name: 'Black', exact: true }).click();
  await dialog.getByRole('radiogroup', { name: 'Workbench density', exact: true }).getByRole('radio', { name: 'Comfortable', exact: true }).click();
  for (const surface of [page, settingsPage]) await surface.waitForFunction(() =>
    document.documentElement.dataset.theme === 'black' && document.documentElement.dataset.density === 'comfortable');
  const settingsZoom = await auditNativeSettingsZoom(settings);
  const settingsImage = 'native-settings-black.png';
  await settingsPage.screenshot({ path: path.join(output, settingsImage), animations: 'disabled', scale: 'css' });
  await closeSettings(settings);
  const reopened = await openSettings(app, page, { requireNative: true });
  const reopenedId = await nativeWindowId(reopened.page);
  assert.notEqual(reopenedId, initialId, 'Closing must release the native Settings window');
  assert.equal(await reopened.dialog.getByRole('combobox', { name: 'Application theme', exact: true }).inputValue(), 'black');
  assert.equal(await reopened.dialog.getByRole('radiogroup', { name: 'Workbench density', exact: true })
    .getByRole('radio', { name: 'Comfortable', exact: true }).getAttribute('aria-checked'), 'true');
  await reopened.dialog.getByRole('tab', { name: 'Saving & export', exact: true }).click();
  assert.equal(await reopened.dialog.getByRole('textbox', { name: 'Default figure DPI' }).inputValue(), savedDpi);
  await closeSettings(reopened);
  assert.deepEqual(await getStudyBinding(), binding, 'Settings must retain the exact study, source, and scientific result');
  await appearance({ theme: before.theme, density: before.density });
  report.checks.push({ name: 'dedicated-settings-singleton-route-guide-drafts-and-persistence',
    initialId, reopenedId, isolation, binding, settings_zoom: settingsZoom, settings_screenshot: settingsImage });
}

async function createOfflineComputeStudy(name, cpus) {
  const destination = path.join(output, `settings-${name}.loci-study`);
  const knownHosts = path.join(output, `settings-${name}-known-hosts`);
  const host = `loci-settings-${name}.invalid`;
  // Encode an authored SSH public-key fixture. No credentials or connection are needed.
  const keyType = 'ssh-ed25519';
  const key = Buffer.concat([Buffer.from('0000000b', 'hex'), Buffer.from(keyType),
    Buffer.from('00000020', 'hex'), createHash('sha256').update(host).digest()]);
  await fs.writeFile(knownHosts, `${host} ${keyType} ${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  const worker = async (...args) => JSON.parse((await exec(artifactPaths.worker, ['--loci', '--json', ...args],
    { timeout: 30000 })).stdout);
  const study = await worker('create', '--project', destination, '--title', `Settings ${name} fixture`);
  assert.deepEqual(study.sources, []);
  const { profile } = await worker('execute', '--project', destination, 'remote_profile_save', '--request', JSON.stringify({
    alias: 'loci-settings-fixture.invalid', known_host: host, known_hosts_file: knownHosts,
    host_key_sha256: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`,
    runtime_python: '/fixture/runtime/bin/python', remote_project_root: '/fixture/settings/input', remote_output_root: '/fixture/settings/output',
    scheduler: 'pbspro', scheduler_bin_dir: null, identity_file: null, queue: null, account: null, pbs_gpu_resource: null,
    allow_direct_compute: false, remote_input_roots: [], connect_timeout_seconds: 1,
    resources: { cpus, memory_mb: cpus * 1024, wall_minutes: 10, gpus: 0 }, expected_revision: 0,
  }));
  return { destination, project_id: study.project.project_id, profile, host_sha256: await sha256(knownHosts) };
}

async function auditComputeStudyBinding() {
  const first = await createOfflineComputeStudy('first', 2);
  const second = await createOfflineComputeStudy('second', 4);
  const rowIdentity = ({ alias, id, revision }) => ({ alias, id, revision });
  assert.notEqual(first.project_id, second.project_id);
  assert.deepEqual(rowIdentity(first.profile), rowIdentity(second.profile));
  assert.notDeepEqual(first.profile.resources, second.profile.resources);
  assert.notEqual(first.host_sha256, second.host_sha256);
  const evidence = report.compute_study_binding = { first, second };

  await app.evaluate(({ dialog }, destinations) => {
    const choose = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Open research study') return choose(...args);
      const item = destinations.shift();
      if (!item) throw new Error('Unexpected synthetic study picker');
      globalThis.__lociDesignPassDialogs.push({ title, simulated: true, held: item.hold });
      if (item.hold) await new Promise(resolve => { globalThis.__lociDesignPassReleaseStudy = resolve; });
      return { canceled: false, filePaths: [item.destination] };
    };
  }, [{ destination: first.destination, hold: false }, { destination: second.destination, hold: true }]);
  await fileMenuAction(page, 'Open study');
  await waitForSnapshot(page, state => state?.project.project_id === first.project_id, 'first synthetic compute study');
  const settings = await openSettings(app, page, { requireNative: true });
  const { page: settingsPage, dialog } = settings;
  settingsPage.on('pageerror', error => report.page_errors.push(String(error)));
  settingsPage.on('request', request => { if (/^https?:/u.test(request.url())) report.network_requests.push(request.url()); });
  // Playwright normally emulates focus on every Chromium page, including background windows.
  const settingsCdp = await settingsPage.context().newCDPSession(settingsPage);
  await settingsCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const settingsId = await nativeWindowId(settingsPage);
  const computeTab = dialog.getByRole('tab', { name: 'Compute', exact: true });
  const studyTargets = dialog.locator('.compute-settings__study');
  const saveTarget = button('Save for all studies', studyTargets);
  const firstSummary = studyTargets.getByText('PBSPRO · 2 CPU · 2 GiB · 10 min', { exact: true });
  const secondSummary = studyTargets.getByText('PBSPRO · 4 CPU · 4 GiB · 10 min', { exact: true });
  const list = () => settingsPage.evaluate(() => window.lociSettings.computeTargets('list', {}));
  const pinDirectory = path.join(output, 'profile/compute-targets-v1.loci-study/ssh-hosts');
  const pinnedHosts = () => fs.readdir(pinDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await computeTab.click();
  await saveTarget.waitFor();
  await firstSummary.waitFor();
  evidence.first_rendered_resources = await firstSummary.textContent();
  const listedFirst = await list();
  assert.ok(typeof listedFirst.study_binding === 'string' && listedFirst.study_binding.length > 0);
  assert.deepEqual(listedFirst.study_profiles, [first.profile]);
  assert.deepEqual(listedFirst.targets, []);
  assert.deepEqual(await pinnedHosts(), []);
  const retired = { study_binding: listedFirst.study_binding, id: first.profile.id,
    revision: first.profile.revision, expected_revision: 0 };

  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), await nativeWindowId(page));
  await settingsPage.waitForFunction(() => !document.hasFocus(), null, { timeout: 10000 });
  evidence.settings_blurred = true;
  try {
    await fileMenuAction(page, 'Open study');
    await app.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (typeof globalThis.__lociDesignPassReleaseStudy !== 'function') {
        if (Date.now() >= deadline) throw new Error('The second study picker did not start');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    });
    // Activate the displayed native Settings control without refocusing the window and refreshing the row.
    assert.ok(await firstSummary.isVisible() && await saveTarget.isVisible() && await saveTarget.isEnabled());
    await saveTarget.evaluate(element => element.click());
    const waiting = dialog.getByRole('alert').filter({ hasText: 'Wait for the study to finish opening.' });
    await waiting.waitFor({ timeout: 10000 });
    evidence.stale_button_activation = 'DOM click without moving focus';
    evidence.rejected_during_picker = await waiting.textContent();
    assert.deepEqual(await pinnedHosts(), []);
  } finally {
    await app.evaluate(() => {
      globalThis.__lociDesignPassReleaseStudy?.();
      delete globalThis.__lociDesignPassReleaseStudy;
    });
  }
  await waitForSnapshot(page, state => state?.project.project_id === second.project_id, 'second synthetic compute study');
  assert.equal(await nativeWindowId(settingsPage), settingsId);
  const rejected = await settingsPage.evaluate(async request => {
    try { await window.lociSettings.computeTargets('remember', request); return null; }
    catch (error) { return error.message; }
  }, retired);
  assert.match(rejected, /The study changed\. Refresh Settings/u);
  evidence.rejected_after_switch = rejected;
  const listedSecond = await list();
  assert.ok(typeof listedSecond.study_binding === 'string' && listedSecond.study_binding.length > 0);
  assert.notEqual(listedSecond.study_binding, listedFirst.study_binding);
  assert.deepEqual(listedSecond.study_profiles, [second.profile]);
  assert.deepEqual(listedSecond.targets, [], 'Rejected saves must leave the application-wide target list empty');
  assert.deepEqual(await pinnedHosts(), [], 'Rejected saves must not copy either SSH host fixture');
  evidence.bindings_differ = true;
  evidence.targets_after_rejections = listedSecond.targets;

  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), settingsId);
  await settingsPage.waitForFunction(() => document.hasFocus(), null, { timeout: 10000 });
  evidence.settings_refocused = true;
  await secondSummary.waitFor();
  assert.equal(await firstSummary.count(), 0, 'Refocused Settings must replace the retired study resources');
  assert.equal(await computeTab.getAttribute('aria-selected'), 'true', 'The Compute tab must stay open during the study switch');
  evidence.second_rendered_resources = await secondSummary.textContent();
  await saveTarget.click();
  await dialog.getByRole('status').filter({ hasText: `${second.profile.alias} is now available in every study.` }).waitFor();
  await dialog.getByRole('list', { name: 'Saved compute targets' }).getByText(second.profile.alias, { exact: true }).waitFor();
  const saved = await list();
  assert.deepEqual(saved.targets, [second.profile], 'Fresh save must copy only the profile listed from the second study');
  assert.deepEqual(saved.study_profiles, [second.profile]);
  assert.deepEqual(await pinnedHosts(), [second.host_sha256]);
  assert.equal(await sha256(path.join(pinDirectory, second.host_sha256)), second.host_sha256);
  assert.equal(await nativeWindowId(settingsPage), settingsId);
  evidence.settings_window_id = settingsId;
  evidence.saved_targets = saved.targets;
  evidence.pinned_host_sha256 = second.host_sha256;
  await settingsCdp.detach();
  await closeSettings(settings);
  report.checks.push({ name: 'native-compute-settings-rejects-retired-study-row', ...evidence });
}

async function frameGeometry() {
  const geometry = await page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      if (!element?.getClientRects().length) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        scroll_width: element.scrollWidth, client_width: element.clientWidth };
    };
    const horizontalOverflow = document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1;
    const overflow = horizontalOverflow ? [...document.querySelectorAll('html, body, #root, main, main *')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || (rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1)) return [];
      const style = getComputedStyle(element);
      return [{ tag: element.tagName, id: element.id, classes: element.getAttribute('class'), right: rect.right,
        width: rect.width, min_width: style.minWidth, scroll_width: element.scrollWidth,
        client_width: element.clientWidth, overflow_x: style.overflowX }];
    }).slice(0, 36) : [];
    return { width: innerWidth, height: innerHeight,
      document_width: document.documentElement.scrollWidth, body_width: document.body.scrollWidth, overflow,
      welcome: box('.image-welcome'), opening: box('.welcome-open-section'), recent: box('.recent-sessions'),
      title: box('main.research-workbench > header'), status: box('.workbench-status'),
      header_separators: [...document.querySelectorAll('main.research-workbench > header > .workbench-header-divider')]
        .filter(element => element.getClientRects().length).map(element => element.getBoundingClientRect().width),
      source_pane: box('.research-sources-pane'), inspector: box('.research-inspector'), tools: box('.research-tool-header'),
      image: box('.image-viewport canvas'), toolbar: box('.research-view-toolbar'),
      controls: box('[aria-label="Task groups"]'), control_height: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')),
    };
  });
  if (geometry.overflow.length) report.layout_overflow = geometry;
  assert.ok(geometry.document_width <= geometry.width + 1,
    `Document layout overflows horizontally (${geometry.document_width}px content at ${geometry.width}px viewport)`);
  assert.ok(geometry.body_width <= geometry.width + 1, 'Body scrolls horizontally');
  return geometry;
}
function insideFrame(rect, frame, label) {
  assert.ok(rect && rect.width > 0 && rect.height > 0 && rect.x >= -1 && rect.y >= -1 &&
    rect.right <= frame.width + 1 && rect.bottom <= frame.height + 1, `${label}: region is not wholly inside the rendered viewport`);
}

async function verifyWelcome() {
  const frame = await frameGeometry();
  for (const name of ['welcome', 'opening', 'recent']) insideFrame(frame[name], frame, name);
  assert.ok(frame.recent.x >= frame.opening.right - 1, 'Recent work must be in a separate right column');
  const opening = page.locator('.welcome-open-section');
  const actions = await Promise.all(['Open images', 'Open folder', 'Open study'].map(async (name, index) => {
    const action = button(name, opening);
    const hint = action.locator('kbd');
    assert.equal(await hint.textContent(), ['⌘O', '⌘⇧O', '⌘⇧P'][index]);
    assert.equal(await hint.isVisible(), true);
    return action.boundingBox();
  }));
  for (let index = 1; index < actions.length; index++) {
    const previous = actions[index - 1], next = actions[index];
    assert.ok(previous && next && Math.abs(previous.x - next.x) <= 1 &&
      Math.abs(previous.width - next.width) <= 1 && previous.y + previous.height <= next.y + 1,
    'Opening choices must stack without overlap');
  }
  await page.getByRole('heading', { name: 'Recent work', exact: true }).waitFor();
  await page.getByText('No recent work yet', { exact: true }).waitFor();
  return frame;
}

async function imageReady(expectedResult = null) {
  const name = `Image viewer: ${source.name}`;
  const overlay = expectedResult ? `${expectedResult.id}:${expectedResult.revision_hash}` : null;
  const view = overlay === null ? ':not([data-result-overlay])' : `[data-result-overlay="${overlay}"]`;
  const locator = page.locator(`.image-viewport[data-viewer-source="${source.id}"][data-prepared="true"]${view}`);
  await locator.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await locator.getAttribute('aria-label'), name);
  await paint();
  const evidence = await locator.evaluate(element => {
    const canvas = element.querySelector('canvas');
    const sample = document.createElement('canvas');
    sample.width = sample.height = 24;
    const ctx = sample.getContext('2d');
    let levels = 0;
    if (canvas?.width && canvas.height && ctx) {
      ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
      const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
      levels = new Set(pixels.filter((_, index) => index % 4 === 0)).size;
    }
    return { source: element.dataset.viewerSource, result_overlay: element.dataset.resultOverlay ?? null,
      bytes: Number(element.dataset.cacheBytes), width: canvas?.width, height: canvas?.height, sampled_red_levels: levels };
  });
  assert.equal(evidence.source, source.id);
  assert.equal(evidence.result_overlay, overlay);
  assert.ok(evidence.bytes > 0 && evidence.width > 0 && evidence.height > 0 && evidence.sampled_red_levels > 1,
    'The fixture image has no distinct painted pixels');
  return evidence;
}

async function verifyWorkbench() {
  const image = await imageReady();
  const frame = await frameGeometry();
  assert.ok(frame.header_separators.every(width => width > 0 && width <= 2),
    'Decorative header separators must leave horizontal space for the document and commands');
  for (const name of ['title', 'status', 'source_pane', 'inspector', 'controls', 'image']) insideFrame(frame[name], frame, name);
  assert.ok(frame.image.y >= frame.title.bottom - 1 && frame.image.bottom <= frame.status.y + 1,
    'Image and workbench bars overlap');
  if (frame.toolbar?.height > 0) assert.ok(frame.image.y >= frame.toolbar.bottom - 1, 'View toolbar overlaps image pixels');
  assert.ok(frame.image.height > frame.title.height + frame.status.height + (frame.toolbar?.height ?? 0),
    'The image field is smaller than the surrounding bars');
  assert.ok(frame.inspector.scroll_width <= frame.inspector.client_width + 1, 'Inspector scrolls horizontally');
  return { ...frame, image_binding: image };
}

async function assertPressedGroup(name) {
  const group = page.getByRole('navigation', { name: 'Task groups', exact: true });
  await button(name, group).and(group.locator('button[aria-pressed="true"]')).waitFor();
}
async function auditShortcuts() {
  await button('Open settings').focus();
  for (const [index, name] of groups.entries()) {
    await page.keyboard.press(`Meta+Digit${index + 1}`);
    await assertPressedGroup(name);
  }
  await page.keyboard.press('Meta+BracketLeft');
  await button('Show image list').waitFor();
  await sourcePane().waitFor({ state: 'hidden' });
  await page.keyboard.press('Meta+BracketLeft');
  await button('Hide image list').waitFor();
  await sourcePane().waitFor({ state: 'visible' });
  await page.keyboard.press('Meta+BracketRight');
  await button('Show tools panel').waitFor();
  await toolHeader().waitFor({ state: 'hidden' });
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('combobox', { name: 'Search all tools', exact: true });
  await search.waitFor();
  const searchFocus = await search.evaluate(element => ({
    focused: document.activeElement === element,
    keyboard_visible: element.matches(':focus-visible'),
  }));
  assert.deepEqual(searchFocus, { focused: true, keyboard_visible: true });
  await search.fill('Segment & measure');
  await search.press('ArrowDown');
  assert.ok(await search.getAttribute('aria-activedescendant'), 'Keyboard search has no active choice');
  await search.press('Enter');
  await assertPressedGroup('Analyze');
  await page.keyboard.press('Meta+k');
  await search.waitFor();
  await search.press('Escape');
  const toggle = button('Search all tools');
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true, 'Escape did not restore focus to the tool search control');
  report.checks.push({ name: 'macos-workbench-shortcuts', keys: ['⌘K', '⌘1', '⌘2', '⌘3', '⌘4', '⌘[', '⌘]'], visible_search_focus: true, restored_search_focus: true });
}

async function runKnownMeasurements() {
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical');
  await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  const threshold = page.getByLabel('Threshold', { exact: true });
  await threshold.fill('50');
  await threshold.press('Tab');
  const minimum = page.getByLabel('Minimum object measure', { exact: true });
  await minimum.fill('1');
  await minimum.press('Tab');
  const before = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(before.results.length, 0, 'A fresh fixture must not already have a result');
  await button('Run recipe').click();
  const completed = await waitForSnapshot(page, snapshot => snapshot?.jobs.some(job =>
    job.operation === 'run_recipe' && job.request.source_id === source.id && job.state === 'succeeded' &&
    job.result_ids.some(id => snapshot.results.some(item => item.id === id))), 'known synthetic segmentation job and result', 60000);
  const jobs = completed.jobs.filter(job => job.operation === 'run_recipe' && job.request.source_id === source.id && job.state === 'succeeded');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].result_ids.length, 1);
  assert.equal(completed.results.length, 1);
  result = completed.results[0];
  assert.equal(result.id, jobs[0].result_ids[0]);
  assert.equal(result.kind, 'segmentation');
  assert.equal(result.source_id, source.id);
  assert.equal(result.source_sha256, fixture.sha256);
  assert.deepEqual(result.selection, { x: 0, y: 0, width: 64, height: 64, c: 0, t: 0, z: 0, level: 0 });
  assert.equal(result.object_count, fixture.expected_objects);
  assert.equal(result.review ?? null, null);
  assert.match(result.revision_hash, /^[a-f0-9]{64}$/u);
  assert.match(result.arrays?.labels?.sha256 ?? '', /^[a-f0-9]{64}$/u);
  return imageReady(result);
}

async function measuredRows() {
  const region = table();
  const grid = region.getByRole('grid', { name: 'Measurements and object table', exact: true });
  await grid.waitFor();
  const rows = await grid.locator('tbody tr').evaluateAll(elements => elements.map(row => {
    // ContextHelp transfers native titles to data-loci-help in the packaged renderer.
    const value = field => {
      const cell = row.querySelector(`[data-field="${field}"] > span`);
      return cell?.getAttribute('data-loci-help') ?? cell?.getAttribute('title') ?? undefined;
    };
    const visible = field => row.querySelector(`[data-field="${field}"]`)?.textContent.trim();
    return { object: Number(value('label')), measure: Number(value('measure')), unit: value('measure_unit'),
      rendered_object: visible('label'), rendered_measure: visible('measure'), rendered_unit: visible('measure_unit') };
  }));
  assert.equal(rows.length, fixture.expected_objects);
  // Independent geometry of the authored 8×8, 8×12 and 6×8 masks at 0.5 µm XY spacing.
  assert.deepEqual(rows.map(row => [row.object, row.measure, row.unit]), [[1, 16, 'um^2'], [2, 24, 'um^2'], [3, 12, 'um^2']]);
  assert.deepEqual(rows.map(row => [row.rendered_object, row.rendered_measure, row.rendered_unit]),
    [['1', '16', 'µm²'], ['2', '24', 'µm²'], ['3', '12', 'µm²']]);
  await region.press('Home');
  await grid.locator('tbody tr:nth-child(1)[aria-selected="true"]').waitFor();
  await region.press('ArrowDown');
  await grid.locator('tbody tr:nth-child(2)[aria-selected="true"]').waitFor();
  await region.press('End');
  await grid.locator('tbody tr:nth-child(3)[aria-selected="true"]').waitFor();
  const scroll = await region.evaluate(element => {
    const inspector = element.closest('.research-inspector');
    if (!inspector) throw new Error('Scientific table has no inspector scroll region');
    const header = inspector.querySelector('.research-tool-header');
    const topBefore = header?.getBoundingClientRect().top;
    const originalY = inspector.scrollTop;
    inspector.scrollTop = inspector.scrollHeight;
    const maxY = inspector.scrollTop;
    const topAfter = header?.getBoundingClientRect().top;
    inspector.scrollTop = originalY;
    const originalX = element.scrollLeft;
    element.scrollLeft = element.scrollWidth;
    const maxX = element.scrollLeft;
    element.scrollLeft = originalX;
    return { max_x: maxX, overflow_x: element.scrollWidth - element.clientWidth,
      max_y: maxY, overflow_y: inspector.scrollHeight - inspector.clientHeight, header_top_before: topBefore, header_top_after: topAfter };
  });
  if (scroll.overflow_x > 1) assert.ok(scroll.max_x > 0, 'Measurements columns cannot scroll inside their region');
  if (scroll.overflow_y > 1) assert.ok(scroll.max_y > 0, 'Inspector content cannot scroll');
  assert.ok(Number.isFinite(scroll.header_top_before) && Math.abs(scroll.header_top_before - scroll.header_top_after) <= 1,
    'Tool header moves out of its fixed region while scientific content scrolls');
  await region.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await paint();
  // The horizontal-scroll probe can reveal a transient macOS overlay scrollbar.
  // Wait for the actual numeric glyphs to be clear before capturing them.
  const gridElement = await grid.elementHandle();
  let visibleMeasurements;
  try {
    const settled = await page.waitForFunction(({ grid, count }) => {
      const values = [...grid.querySelectorAll('tbody td[data-field="measure"] > span')];
      const evidence = values.map(value => {
        const { x, y, width, height } = value.getBoundingClientRect();
        const hit = document.elementFromPoint(x + width / 2, y + height / 2);
        return { value: value.textContent.trim(), visible: value.contains(hit), bounds: { x, y, width, height } };
      });
      return evidence.length === count && evidence.every(value => value.visible) ? evidence : false;
    }, { grid: gridElement, count: rows.length }, { timeout: 4000 });
    visibleMeasurements = await settled.jsonValue();
    await settled.dispose();
  } finally { await gridElement.dispose(); }
  assert.deepEqual(visibleMeasurements.map(value => value.value), rows.map(row => row.rendered_measure));
  return { rows, scroll, visible_measurements: visibleMeasurements };
}

async function actualZoom() {
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await paint();
  const baseline = await viewport();
  const panels = {
    sources: await button('Hide image list').isVisible(),
    tools: await button('Hide tools panel').isVisible(),
  };
  const setZoom = factor => app.evaluate(({ BrowserWindow }, value) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.setZoomFactor(value);
    return contents.getZoomFactor();
  }, factor);
  assert.ok(Math.abs(await setZoom(2) - 2) < 1e-9, 'Electron must report a true 200% zoom factor');
  try {
    await page.waitForFunction(before => Math.abs(innerWidth * 2 - before.width) <= 2 &&
      Math.abs(innerHeight * 2 - before.height) <= 2 && Math.abs(devicePixelRatio / before.dpr - 2) < 0.02, baseline);
    await button('Open settings').focus();
    if (await button('Hide image list').isVisible()) await page.keyboard.press('Meta+BracketLeft');
    if (await button('Hide tools panel').isVisible()) await page.keyboard.press('Meta+BracketRight');
    await page.locator('main.research-workbench').evaluate(element => { element.scrollTop = 0; });
    const binding = await imageReady(result);
    const zoomedImage = await frameGeometry();
    assert.ok(zoomedImage.image && zoomedImage.title, '200% zoom hides the image or the workbench header');
    const visibleImageHeight = Math.min(zoomedImage.image.bottom, zoomedImage.height) -
      Math.max(zoomedImage.image.y, zoomedImage.title.bottom);
    assert.ok(visibleImageHeight >= zoomedImage.height / 3, '200% zoom leaves the image field mostly outside the viewport');
    await capture('zoom-200-native-image', { ...zoomedImage, image_binding: binding }, { nativeZoom: true });
    await page.keyboard.press('Meta+k');
    const search = page.getByRole('combobox', { name: 'Search all tools', exact: true });
    await search.waitFor();
    assert.equal(await search.evaluate(element => document.activeElement === element), true);
    await search.fill('Segment & measure');
    await search.press('Enter');
    const scientific = await measuredRows();
    await capture('zoom-200-native-measurements', { ...await frameGeometry(), ...scientific }, { nativeZoom: true });
    report.checks.push({ name: 'native-electron-page-zoom-200-percent', baseline, zoomed: await viewport(), ...scientific });
  } catch (error) {
    await capture('zoom-200-native-failure', report.layout_overflow ?? null, { nativeZoom: true }).catch(error => {
      report.zoom_capture_error = String(error);
    });
    throw error;
  } finally { assert.equal(await setZoom(1), 1); }
  await page.waitForFunction(before => innerWidth === before.width && innerHeight === before.height && devicePixelRatio === before.dpr, baseline);
  for (const [shown, hide, show] of [
    [panels.sources, 'Hide image list', 'Show image list'], [panels.tools, 'Hide tools panel', 'Show tools panel'],
  ]) {
    const expected = button(shown ? hide : show);
    if (!await expected.count()) await button(shown ? show : hide).click();
    await expected.waitFor();
  }
  const restored = await viewport();
  assert.deepEqual(restored, baseline, 'Chrome preferences or native size changed during zoom');
  const after = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.ok(after.sources.some(item => item.id === source.id && item.sha256 === fixture.sha256));
  assert.deepEqual(after.results.filter(item => item.id === result.id).map(item => item.revision_hash), [result.revision_hash]);
  assert.ok(after.results.every(item => !item.review));
  await capture('zoom-restored-source-and-result', { ...await frameGeometry(), image_binding: await imageReady(result) });
}

try {
  report.identity = JSON.parse(await fs.readFile(artifactPaths.identity, 'utf8'));
  assert.equal(report.identity.sourceRevision, env.LOCI_QA_SOURCE_COMMIT);
  assert.equal(report.identity.sourceDirty, false);
  report.artifacts = await artifactHashes();
  report.harness_sha256 = await sha256(import.meta.filename);
  report.fixture_generator_sha256 = await sha256(fixtureGenerator);
  report.stage = 'generated-fixture';
  fixture = JSON.parse((await exec(python, [fixtureHelper, 'fixture', output], { timeout: 30000 })).stdout);
  assert.equal(path.dirname(fixture.source), output);
  assert.equal(await sha256(fixture.source), fixture.sha256);
  report.fixture = fixture;
  report.stage = 'launch-and-display';
  app = await electron.launch({ executablePath: artifactPaths.executable,
    args: [`--user-data-dir=${path.join(output, 'profile')}`], cwd: desktop, timeout: 120000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.page_errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.console_errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/u.test(request.url())) report.network_requests.push(request.url()); });
  const placement = await placeQaWindow(app, { requestedDisplay: env.LOCI_QA_SECONDARY_DISPLAY, launch: 1 }, report);
  display = placement.selected_display;
  cdp = await page.context().newCDPSession(page);
  await page.getByRole('heading', { name: 'Open data', exact: true }).waitFor();
  await app.evaluate(({ dialog }, file) => {
    globalThis.__lociDesignPassDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== 'Add microscopy or medical images') throw new Error(`Unexpected picker: ${title}`);
      globalThis.__lociDesignPassDialogs.push({ title, simulated: true });
      return { canceled: false, filePaths: [file] };
    };
  }, fixture.source);
  report.stage = 'welcome-appearance-matrix';
  for (const [width, height] of sizes) {
    await resize(width, height, 'welcome');
    for (const profile of profiles) {
      await appearance(profile);
      await capture(`welcome-${width}-${profile.theme}-${profile.density}`, await verifyWelcome());
    }
    await save();
  }
  report.stage = 'native-image-open';
  await button('Open images').click();
  const snapshot = await waitForSnapshot(page, state => state?.sources.some(item => item.sha256 === fixture.sha256), 'generated source binding');
  source = snapshot.sources.find(item => item.sha256 === fixture.sha256);
  assert.ok(source.id && source.locator_state !== 'relink-required');
  report.source = { id: source.id, sha256: source.sha256, name: source.name };
  await imageReady();
  report.stage = 'workbench-appearance-matrix';
  for (const [width, height] of sizes) {
    await resize(width, height, 'workbench');
    for (const profile of profiles) {
      await appearance(profile);
      const frame = await verifyWorkbench();
      report.capture_density ??= {};
      report.capture_density[profile.density] = frame.control_height;
      await capture(`workbench-${width}-${profile.theme}-${profile.density}`, frame);
    }
    await save();
  }
  assert.ok(report.capture_density.comfortable > report.capture_density.compact, 'Density preference did not enlarge controls');
  report.stage = 'shortcuts-and-scientific-table';
  await selectWorkbenchTool(page, 'Analyze');
  for (const [width, height] of sizes) {
    await resize(width, height, 'display-channel-hit-target');
    const channelToggle = page.locator('.research-view-toolbar .compact-channel-controls > summary');
    const canOpenChannels = await channelToggle.evaluate(summary => {
      const { x, y, width, height } = summary.getBoundingClientRect();
      return summary.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    });
    assert.ok(canOpenChannels, 'The display channel toggle must accept a click inside the image stage');
    await channelToggle.click();
    assert.equal(await channelToggle.evaluate(summary => summary.parentElement.open), true);
    await channelToggle.click();
  }
  report.checks.push({ name: 'display-channel-toggle-in-analysis', tested_widths: sizes.map(([width]) => width) });
  await resize(1280, 800, 'shortcuts');
  await auditShortcuts();
  const resultImage = await runKnownMeasurements();
  const measurements = await measuredRows();
  report.result = { id: result.id, revision_hash: result.revision_hash, object_count: result.object_count,
    labels_sha256: result.arrays.labels.sha256, selection: result.selection, ...measurements };
  await capture('workbench-exact-synthetic-measurements', { ...await frameGeometry(), image_binding: resultImage, ...measurements });
  report.stage = 'native-settings';
  await auditNativeSettings();
  report.stage = 'native-electron-zoom';
  await actualZoom();
  report.stage = 'native-compute-study-binding';
  await auditComputeStudyBinding();
  report.dialogs = await app.evaluate(() => globalThis.__lociDesignPassDialogs);
  assert.deepEqual(report.dialogs, [{ title: 'Add microscopy or medical images', simulated: true },
    { title: 'Open research study', simulated: true, held: false }, { title: 'Open research study', simulated: true, held: true }]);
  assert.deepEqual(report.page_errors, []);
  assert.deepEqual(report.console_errors, []);
  assert.deepEqual(report.network_requests, []);
  assert.equal(await sha256(fixture.source), fixture.sha256, 'The fixture source changed');
  assert.deepEqual(await artifactHashes(), report.artifacts, 'Packaged artifacts changed during the journey');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack ?? error);
  if (page && !page.isClosed()) await capture('failure').catch(() => undefined);
  throw error;
} finally {
  try { if (app) await app.close(); }
  catch (error) { report.status = 'failed'; report.close_error = String(error); process.exitCode = 1; }
  report.finished_at = new Date().toISOString();
  await save();
  process.stdout.write(`${path.join(output, 'receipt.json')}\n`);
}
