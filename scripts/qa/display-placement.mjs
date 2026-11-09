import assert from 'node:assert/strict';

const isSidecar = display => /sidecar|ipad/iu.test(display.label ?? '');

// Pure selection keeps placement policy testable without launching Electron.
export function selectQaDisplay(inventory, { requestedDisplay, margin = 15 } = {}) {
  const { displays, primary_id: primaryId, minimum_size: [minimumWidth, minimumHeight] } = inventory;
  assert.ok(Number.isSafeInteger(margin) && margin >= 0, 'Invalid QA display margin');
  assert.ok(minimumWidth > 0 && minimumHeight > 0, 'A live window minimum size is required');
  const fits = display => display.workArea.width >= minimumWidth + margin * 2 && display.workArea.height >= minimumHeight + margin * 2;
  const explicit = requestedDisplay !== undefined && requestedDisplay !== '';
  const candidates = explicit
    ? displays.filter(display => String(display.id) === requestedDisplay || display.label === requestedDisplay)
    : displays.filter(isSidecar);
  if (explicit) assert.equal(candidates.length, 1, `Expected one explicitly requested display ${JSON.stringify(requestedDisplay)}; found ${candidates.length}`);
  const desired = candidates.find(fits);
  const selected = desired ?? displays.find(display => display.id === primaryId && fits(display));
  assert.ok(selected, `No connected preferred or primary display fits the live ${minimumWidth}x${minimumHeight} window minimum with ${margin}px margins`);
  const fallbackReason = desired ? null : explicit ? 'explicit-display-too-small' : candidates.length ? 'sidecar-too-small' : 'sidecar-unavailable';
  const area = selected.workArea;
  return {
    selected_display: selected,
    requested_display: requestedDisplay ?? null,
    fallback_reason: fallbackReason,
    selection_reason: desired ? explicit ? 'explicit-display' : 'sidecar-label' : 'primary-fallback',
    sidecar_identified_by_label: isSidecar(selected),
    requested_bounds: { x: area.x + margin, y: area.y + margin, width: Math.max(minimumWidth, Math.min(1440, area.width - margin * 2)), height: Math.max(minimumHeight, Math.min(1000, area.height - margin * 2)) },
  };
}

export async function placeQaWindow(app, { requestedDisplay, margin = 15, launch }, report) {
  const inventory = await app.evaluate(({ BrowserWindow, screen }) => ({
    primary_id: screen.getPrimaryDisplay().id,
    minimum_size: BrowserWindow.getAllWindows()[0].getMinimumSize(),
    displays: screen.getAllDisplays().map(({ id, label, workArea, bounds, scaleFactor, internal }) => ({ id, label, workArea, bounds, scaleFactor, internal })),
  }));
  report.display_inventory ??= inventory;
  report.latest_display_inventory = inventory;
  // Retain even rejected explicit requests and their actual connected inventory.
  const placement = { launch, inventory, requested_display: requestedDisplay ?? null, status: 'selecting' };
  (report.display_placements ??= []).push(placement);
  Object.assign(placement, selectQaDisplay(inventory, { requestedDisplay, margin }), { status: 'placing' });
  const actual = await app.evaluate(({ BrowserWindow, screen }, bounds) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds(bounds); window.show();
    const actualBounds = window.getBounds();
    return { bounds: actualBounds, display_id: screen.getDisplayMatching(actualBounds).id,
      displays: screen.getAllDisplays().map(({ id, label, workArea }) => ({ id, label, workArea })) };
  }, placement.requested_bounds);
  placement.actual = actual;
  const selected = actual.displays.find(display => display.id === placement.selected_display.id);
  assert.ok(selected, 'Selected display disconnected during placement');
  assert.equal(actual.display_id, selected.id, 'Actual window is on a different display');
  const area = selected.workArea, bounds = actual.bounds;
  assert.ok(bounds.width >= inventory.minimum_size[0] && bounds.height >= inventory.minimum_size[1], 'Actual window is below its live minimum size');
  assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, 'Actual window must remain inside the selected visible work area');
  placement.status = 'placed';
  return placement;
}
