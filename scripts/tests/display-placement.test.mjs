import test from 'node:test';
import assert from 'node:assert/strict';
import { placeQaWindow, selectQaDisplay } from '../qa/display-placement.mjs';

const display = (id, label, workArea = { x: 0, y: 25, width: 1800, height: 1100 }) => ({ id, label, workArea, bounds: { ...workArea }, scaleFactor: 2, internal: id === 1 });
const primary = display(1, 'Built-in Retina Display');
const sidecar = display(42, 'iPad (Sidecar)', { x: -1366, y: -120, width: 1366, height: 1000 });
const inventory = (displays = [primary, sidecar], minimum = [1024, 720]) => ({ primary_id: 1, minimum_size: minimum, displays });

test('prefers connected Sidecar/iPad and places within its offset visible work area', () => {
  const result = selectQaDisplay(inventory());
  assert.equal(result.selected_display, sidecar);
  assert.equal(result.selection_reason, 'sidecar-label');
  assert.equal(result.fallback_reason, null);
  assert.equal(result.sidecar_identified_by_label, true);
  assert.deepEqual(result.requested_bounds, { x: -1351, y: -105, width: 1336, height: 970 });
  assert.equal(selectQaDisplay(inventory([primary, display(2, 'Sidecar Display')])).selected_display.id, 2);
});

test('explicit Electron ID and exact label select any connected display', () => {
  const external = display(9, 'External monitor');
  for (const requestedDisplay of ['9', 'External monitor']) {
    const result = selectQaDisplay(inventory([primary, sidecar, external]), { requestedDisplay, margin: 10 });
    assert.equal(result.selected_display, external);
    assert.equal(result.selection_reason, 'explicit-display');
    assert.equal(result.fallback_reason, null);
    assert.deepEqual(result.requested_bounds, { x: 10, y: 35, width: 1440, height: 1000 });
  }
  assert.equal(selectQaDisplay(inventory(), { requestedDisplay: '1' }).selected_display, primary);
});

test('missing, partial-label, and ambiguous explicit requests fail instead of falling back', () => {
  for (const requestedDisplay of ['43', 'iPad', 'External monitor']) {
    assert.throws(() => selectQaDisplay(inventory(), { requestedDisplay }), /explicitly requested display.*found 0/u);
  }
  assert.throws(() => selectQaDisplay(inventory([primary, sidecar, display(43, sidecar.label)]), { requestedDisplay: sidecar.label }), /found 2/u);
});

test('primary fallback records whether Sidecar is unavailable or too small', () => {
  assert.equal(selectQaDisplay(inventory([primary])).fallback_reason, 'sidecar-unavailable');
  const portrait = display(42, 'iPad', { x: 1800, y: 0, width: 1000, height: 1366 });
  const fallback = selectQaDisplay(inventory([primary, portrait]));
  assert.equal(fallback.selected_display, primary);
  assert.equal(fallback.selection_reason, 'primary-fallback');
  assert.equal(fallback.fallback_reason, 'sidecar-too-small');
  assert.equal(selectQaDisplay(inventory([primary, portrait]), { requestedDisplay: '42' }).fallback_reason, 'explicit-display-too-small');
});

test('uses the live minimum plus margins and caps preferred dimensions without undercutting it', () => {
  const exact = display(42, 'iPad', { x: 0, y: 0, width: 1054, height: 750 });
  assert.deepEqual(selectQaDisplay(inventory([primary, exact])).requested_bounds, { x: 15, y: 15, width: 1024, height: 720 });
  assert.equal(selectQaDisplay(inventory([primary, exact], [1025, 720])).fallback_reason, 'sidecar-too-small');
  assert.deepEqual(selectQaDisplay(inventory([primary], [1500, 1050])).requested_bounds, { x: 15, y: 40, width: 1500, height: 1050 });
  assert.throws(() => selectQaDisplay(inventory([exact], [1100, 720])), /No connected preferred or primary display fits/u);
});

function fakeApp({ actualBounds, actualDisplayId, finalDisplays } = {}) {
  let bounds;
  let reads = 0;
  const window = {
    getMinimumSize: () => [1024, 720],
    setBounds: value => { bounds = value; },
    show() {},
    getBounds: () => actualBounds ?? bounds,
  };
  const electron = {
    BrowserWindow: { getAllWindows: () => [window] },
    screen: {
      getPrimaryDisplay: () => primary,
      getAllDisplays: () => ++reads > 1 ? finalDisplays ?? [primary, sidecar] : [primary, sidecar],
      getDisplayMatching: () => ({ id: actualDisplayId ?? sidecar.id }),
    },
  };
  return { evaluate: async (callback, value) => callback(electron, value) };
}

test('records real inventory, live minimum, requested and actual placement for each launch', async () => {
  const report = {};
  const first = await placeQaWindow(fakeApp(), { launch: 1, margin: 15 }, report);
  const second = await placeQaWindow(fakeApp(), { launch: 2, margin: 10 }, report);
  assert.equal(first.status, 'placed');
  assert.equal(second.status, 'placed');
  assert.equal(report.display_inventory, first.inventory);
  assert.equal(report.latest_display_inventory, second.inventory);
  assert.deepEqual(first.inventory.minimum_size, [1024, 720]);
  assert.equal(report.display_placements.length, 2);
  assert.deepEqual(first.actual.bounds, first.requested_bounds);
  assert.equal(first.actual.display_id, sidecar.id);
});

test('retains inventory evidence for a rejected explicit display', async () => {
  const report = {};
  await assert.rejects(placeQaWindow(fakeApp(), { launch: 1, requestedDisplay: 'missing' }, report), /found 0/u);
  assert.equal(report.display_placements[0].requested_display, 'missing');
  assert.equal(report.display_inventory.displays.length, 2);
});

test('rejects actual offscreen, wrong-display, undersized, or disconnected placement with evidence', async () => {
  for (const [options, message] of [
    [{ actualBounds: { x: -1400, y: -105, width: 1336, height: 970 } }, /inside the selected visible work area/u],
    [{ actualDisplayId: 1 }, /different display/u],
    [{ actualBounds: { x: -1351, y: -105, width: 1000, height: 970 } }, /below its live minimum/u],
    [{ finalDisplays: [primary] }, /disconnected/u],
  ]) {
    const report = {};
    await assert.rejects(placeQaWindow(fakeApp(options), { launch: 1 }, report), message);
    assert.ok(report.display_placements[0].actual);
    assert.equal(report.display_placements[0].status, 'placing');
  }
});
