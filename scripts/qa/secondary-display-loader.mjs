import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DISPLAY_NAME = process.env.LOCI_QA_SECONDARY_DISPLAY;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function extractUserDataDir(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--user-data-dir=')) return path.resolve(arg.slice('--user-data-dir='.length));
    if (arg === '--user-data-dir' && typeof args[index + 1] === 'string') return path.resolve(args[index + 1]);
  }
  throw new Error('Secondary-display QA requires an exact --user-data-dir argument.');
}

export function cocoaScreenToElectron(screen, primaryTop) {
  const { x, y, width, height } = screen.frame;
  const visible = screen.visibleFrame;
  return {
    id: Number(screen.id),
    name: screen.name,
    primary: Boolean(screen.primary),
    bounds: { x, y: primaryTop - (y + height), width, height },
    workArea: { x: visible.x, y: primaryTop - (visible.y + visible.height), width: visible.width, height: visible.height },
  };
}

export function selectSecondaryDisplay(displays, name) {
  const matches = displays.filter(({ name: displayName }) => displayName === name);
  if (matches.length !== 1) throw new Error(`Expected one display named ${JSON.stringify(name)}; found ${matches.length}.`);
  const display = matches[0];
  if (display.primary) throw new Error(`Display ${JSON.stringify(name)} is the primary display.`);
  if (display.bounds.width < 1024 || display.bounds.height < 720) throw new Error(`Display ${JSON.stringify(name)} is below the 1024x720 minimum.`);
  return display;
}

export function windowBoundsFor(display) {
  const area = display.workArea;
  const width = Math.min(1366, area.width);
  const height = Math.min(1024, area.height);
  if (width < 1024 || height < 720) throw new Error(`Display ${JSON.stringify(display.name)} has less than 1024x720 usable area.`);
  return { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
}

// JXA reads AppKit without compiling a Swift program at every QA launch.
const screenQuery = String.raw`
ObjC.import('AppKit');
const screens = $.NSScreen.screens.js;
if (!screens.length) throw new Error('No NSScreen available');
const primary = screens.findIndex(s => s.frame.origin.x === 0 && s.frame.origin.y === 0);
if (primary < 0) throw new Error('No primary NSScreen origin');
const primaryTop = screens[primary].frame.size.height;
const rect = r => ({x:r.origin.x, y:r.origin.y, width:r.size.width, height:r.size.height});
JSON.stringify(screens.map((s, i) => ({
  id: s.deviceDescription.objectForKey('NSScreenNumber').js,
  name: s.localizedName.js, primary: i === primary,
  frame: rect(s.frame), visibleFrame: rect(s.visibleFrame), primaryTop
})));
`;

function queryDisplays() {
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', screenQuery], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`NSScreen query failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  let raw;
  try { raw = JSON.parse(result.stdout); } catch { throw new Error(`NSScreen query returned invalid JSON: ${result.stdout.slice(0, 300)}`); }
  const primaryTop = raw.find((screen) => screen.primary)?.primaryTop ?? raw[0]?.primaryTop;
  return raw.map((screen) => cocoaScreenToElectron(screen, primaryTop));
}

function trace(event, values = {}) {
  process.stdout.write(`${JSON.stringify({ qa: 'secondary-display', event, ...values })}\n`);
}

async function prepareProfile(profile, bounds) {
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'window-state.json'), `${JSON.stringify(bounds)}\n`, { encoding: 'utf8', flag: 'w' });
}

async function protectLaunchedApp(app, selected) {
  const actual = await app.evaluate(({ screen }) => screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor, primary: screen.getPrimaryDisplay().id === id })));
  const target = actual.filter((display) => display.id === selected.id);
  if (target.length !== 1 || target[0].primary) throw new Error(`Electron did not expose the selected non-primary display id ${selected.id}.`);
  const targetDisplay = target[0];
  // Electron launch can resolve before the app creates its first window.
  await app.firstWindow();
  const windows = app.windows();
  if (!windows.length) throw new Error('Electron launched without a BrowserWindow.');
  const chosen = windowBoundsFor({ ...selected, workArea: targetDisplay.workArea });
  await app.evaluate((_electron, bounds) => {
    const { BrowserWindow } = _electron;
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('No BrowserWindow to place on the selected display.');
    window.setBounds(bounds);
    window.show();
    window.focus();
  }, chosen);
  const state = await app.evaluate((_electron) => {
    const { BrowserWindow, screen } = _electron;
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return { bounds, displayId: display.id, displays: screen.getAllDisplays().map(({ id, bounds: b, primary }) => ({ id, bounds: b, primary })) };
  });
  if (state.displayId !== selected.id || state.bounds.x < targetDisplay.workArea.x || state.bounds.y < targetDisplay.workArea.y || state.bounds.x + state.bounds.width > targetDisplay.workArea.x + targetDisplay.workArea.width || state.bounds.y + state.bounds.height > targetDisplay.workArea.y + targetDisplay.workArea.height) {
    throw new Error(`Electron main window failed target-display placement: ${JSON.stringify(state)}`);
  }

  await app.evaluate((_electron, targetId) => {
    const { BrowserWindow, screen, app } = _electron;
    let failed = false;
    const fail = (reason) => {
      if (failed) return;
      failed = true;
      process.exitCode = 1;
      console.error(JSON.stringify({ qa: 'secondary-display', event: 'display-guard-failure', reason }));
      for (const window of BrowserWindow.getAllWindows()) window.hide();
      app.quit();
    };
    let adjusting = false;
    const clamp = (window) => {
      if (adjusting || window.isDestroyed()) return;
      const display = screen.getAllDisplays().find(({ id }) => id === targetId);
      if (!display || display.id === screen.getPrimaryDisplay().id) return fail('selected display was removed or became primary');
      const area = display.workArea;
      const bounds = window.getBounds();
      const width = Math.min(bounds.width, area.width);
      const height = Math.min(bounds.height, area.height);
      const fitted = { x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width), y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height), width, height };
      if (JSON.stringify(bounds) !== JSON.stringify(fitted)) {
        adjusting = true;
        window.setBounds(fitted);
        setImmediate(() => { adjusting = false; });
      }
    };
    const validate = () => {
      const display = screen.getAllDisplays().find(({ id }) => id === targetId);
      if (!display || display.id === screen.getPrimaryDisplay().id || display.bounds.width < 1024 || display.bounds.height < 720) return fail('selected display lost or fell below minimum size');
      for (const window of BrowserWindow.getAllWindows()) clamp(window);
    };
    screen.on('display-removed', validate);
    screen.on('display-metrics-changed', validate);
    const guardWindow = (window) => {
      window.on('move', () => clamp(window));
      window.on('resize', () => clamp(window));
      clamp(window);
    };
    for (const window of BrowserWindow.getAllWindows()) guardWindow(window);
    app.on('browser-window-created', (_event, window) => guardWindow(window));
  }, selected.id);
  trace('launch-placed', { display: { id: selected.id, name: selected.name }, bounds: state.bounds });
}

if (DISPLAY_NAME) {
  if (process.platform !== 'darwin') throw new Error('Secondary-display QA loader supports macOS only.');
  const displays = queryDisplays();
  const selected = selectSecondaryDisplay(displays, DISPLAY_NAME);
  const requireFromDesktop = createRequire(path.join(root, 'desktop', 'package.json'));
  const { _electron } = requireFromDesktop('playwright');
  const originalLaunch = _electron.launch.bind(_electron);
  _electron.launch = async (options = {}) => {
    const profile = extractUserDataDir(options.args ?? []);
    const bounds = windowBoundsFor(selected);
    await prepareProfile(profile, bounds);
    trace('launch-request', { display: { id: selected.id, name: selected.name }, profile, bounds });
    let app;
    try {
      app = await originalLaunch(options);
      await protectLaunchedApp(app, selected);
      return app;
    } catch (error) {
      if (app) {
        try { await app.evaluate(({ app: electronApp, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); electronApp.quit(); }); } catch {}
      }
      throw error;
    }
  };
  trace('enabled', { display: { id: selected.id, name: selected.name }, displays });
}
