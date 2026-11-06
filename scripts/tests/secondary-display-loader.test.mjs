import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cocoaScreenToElectron,
  extractUserDataDir,
  selectSecondaryDisplay,
  windowBoundsFor,
} from '../qa/secondary-display-loader.mjs';

test('extracts only an explicit user-data-dir argument', () => {
  assert.equal(extractUserDataDir(['--foo', '--user-data-dir=/tmp/qa-profile']), '/tmp/qa-profile');
  assert.equal(extractUserDataDir(['--user-data-dir', '/tmp/qa-profile']), '/tmp/qa-profile');
  assert.throws(() => extractUserDataDir(['--user-data-dirx=/tmp/nope']), /exact --user-data-dir/);
});

test('converts Cocoa bottom-origin display coordinates to Electron top-origin coordinates', () => {
  const display = cocoaScreenToElectron({
    id: 42,
    name: 'Sidecar Display',
    primary: false,
    frame: { x: 1440, y: -200, width: 1366, height: 1024 },
    visibleFrame: { x: 1440, y: -200, width: 1366, height: 1000 },
  }, 900);
  assert.deepEqual(display.bounds, { x: 1440, y: 76, width: 1366, height: 1024 });
  assert.deepEqual(display.workArea, { x: 1440, y: 100, width: 1366, height: 1000 });
});

test('requires exactly one non-primary named display with adequate dimensions', () => {
  const display = { id: 7, name: 'Sidecar Display', primary: false, bounds: { x: 0, y: 0, width: 1366, height: 1024 }, workArea: { x: 0, y: 24, width: 1366, height: 1000 } };
  assert.equal(selectSecondaryDisplay([display], 'Sidecar Display'), display);
  assert.throws(() => selectSecondaryDisplay([display, display], 'Sidecar Display'), /found 2/);
  assert.throws(() => selectSecondaryDisplay([{ ...display, primary: true }], 'Sidecar Display'), /primary/);
  assert.throws(() => selectSecondaryDisplay([{ ...display, bounds: { width: 1000, height: 800 } }], 'Sidecar Display'), /below the 1024x720 minimum/);
});

test('clamps launch size to the selected work area while respecting the QA range', () => {
  const display = { name: 'Sidecar Display', workArea: { x: 1400, y: 30, width: 1280, height: 900 } };
  assert.deepEqual(windowBoundsFor(display), { x: 1400, y: 30, width: 1280, height: 900 });
  assert.deepEqual(windowBoundsFor({ name: 'large', workArea: { x: 200, y: 10, width: 1800, height: 1200 } }), { x: 417, y: 98, width: 1366, height: 1024 });
  assert.throws(() => windowBoundsFor({ name: 'small', workArea: { x: 0, y: 0, width: 1000, height: 700 } }), /less than 1024x720/);
});
