import assert from "node:assert/strict";

// CDP input is delivered to this renderer through Chromium's pointer pipeline.
// The operating-system mouse stays where it is. Read it independently in Electron.
export const pointerDispatch = {
  mechanism: "Chromium CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent",
  scope: "Loci renderer only; uses browser input and DOM pointer capture",
  physical_mouse_verified: false,
  os_pointer_moved_by_harness: false,
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const outside = ({ x, y }, { width, height }) => x < 0 || y < 0 || x >= width || y >= height;

async function rendererGesture(page, locator, record, { grip, side, outcome, beforeRelease }) {
  await grip.scrollIntoViewIfNeeded();
  await grip.hover();
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const start = await grip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  });
  const edge = { x: side === "left" ? -48 : dimensions.width + 48, y: start.y };
  const reentry = { x: clamp(start.x + (side === "left" ? 24 : -24), 2, dimensions.width - 2), y: start.y };
  const release = outcome === "reenter" ? reentry : edge;
  Object.assign(record, { main_client_size: dimensions, pressed_at: start, dragged_to: edge, released_at: release });
  const cdp = await page.context().newCDPSession(page);
  let pressed = false;
  const send = (type, point, buttons, button) => cdp.send("Input.dispatchMouseEvent", {
    type, ...point, buttons, button, ...(type === "mouseMoved" ? {} : { clickCount: 1 }), pointerType: "mouse",
  });
  await locator.evaluate((element) => {
    const cleanup = new AbortController();
    const events = [];
    globalThis.__lociQaPointerTrace = { cleanup, events };
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "keydown"]) {
      window.addEventListener(type, (event) => {
        if (type === "keydown" && event.key !== "Escape") return;
        const pointer = type !== "keydown";
        const row = { type, trusted: event.isTrusted, handle_target: event.target === element || (event.target instanceof Node && element.contains(event.target)) };
        events.push(pointer ? { ...row, x: event.clientX, y: event.clientY, screen_x: event.screenX, screen_y: event.screenY,
          buttons: event.buttons, pointer_type: event.pointerType, captured: element.hasPointerCapture(event.pointerId) } : { ...row, key: event.key });
      }, { capture: true, signal: cleanup.signal });
    }
  });
  try {
    await send("mousePressed", start, 1, "left");
    pressed = true;
    for (const progress of [0.1, 0.4, 0.75, 1]) {
      const x = Math.round(start.x + (edge.x - start.x) * progress);
      await send("mouseMoved", { x, y: edge.y }, 1, "left");
    }
    if (outcome === "reenter") await send("mouseMoved", reentry, 1, "left");
    if (outcome === "escape") {
      const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    }
    await beforeRelease();
    await send("mouseReleased", release, 0, "left");
    pressed = false;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally {
    if (pressed) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
      await send("mouseReleased", start, 0, "left").catch(() => {});
    }
    await cdp.detach().catch(() => {});
    if (!page.isClosed()) {
      record.renderer_events = await page.evaluate(() => {
        const { cleanup, events } = globalThis.__lociQaPointerTrace;
        cleanup.abort();
        delete globalThis.__lociQaPointerTrace;
        return events;
      });
    }
  }
  const events = record.renderer_events;
  assert.ok(events.some(event => event.type === "pointerdown" && event.trusted && event.pointer_type === "mouse" && event.buttons === 1 && event.handle_target),
    "Chromium did not send a trusted left-button PointerEvent to the hovered control");
  assert.ok(events.some(event => event.type === "pointermove" && event.trusted && event.buttons === 1 && Math.abs(event.x - start.x) >= 8),
    "Chromium did not deliver a held left-button pointer movement");
  if (outcome !== "unrelated") {
    assert.ok(events.some(event => event.type === "pointermove" && event.trusted && event.buttons === 1 && event.captured && outside(event, dimensions)),
      "The held mouse must cross the client edge while the drag control owns pointer capture");
  }
  if (outcome === "drop" || outcome === "reenter") {
    const up = events.find(event => event.type === "pointerup" && event.trusted && event.buttons === 0);
    assert.ok(up?.handle_target && up.captured && outside(up, dimensions) === (outcome === "drop"),
      `The captured mouse release did not occur ${outcome === "drop" ? "outside" : "back inside"} the client frame`);
    record.renderer_release_screen_dip = { x: Math.round(up.screen_x), y: Math.round(up.screen_y) };
  }
  if (outcome === "escape") {
    assert.ok(events.some(event => event.type === "keydown" && event.key === "Escape" && event.trusted), "Chromium did not deliver Escape");
  }
}

const nativeIds = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id).sort((a, b) => a - b));
const nativePointer = (app) => app.evaluate(({ screen }) => {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  return { point, display_id: display.id, work_area: display.workArea };
});

async function nativeDetails(app, page) {
  const window = await app.browserWindow(page);
  try {
    return await window.evaluate(win => ({ id: win.id, title: win.getTitle(), bounds: win.getBounds(),
      content_bounds: win.getContentBounds(), fullscreen: win.isFullScreen(), maximized: win.isMaximized() }));
  } finally {
    await window.dispose();
  }
}

export async function checkPointerGesture({ app, main, locator, grip = locator, label, cases, poll, side = "right", outcome = "drop", title }) {
  const record = { label, outcome, side, status: "running" };
  cases.push(record);
  const before = await nativeIds(app);
  record.native_ids_before = before;
  const mainWindow = await nativeDetails(app, main);
  record.main_window = mainWindow;
  assert.ok(!mainWindow.fullscreen && !mainWindow.maximized, "Exercise the outside drop from a windowed main workbench");
  const opened = [];
  const listener = page => opened.push(page);
  app.on("window", listener);
  try {
    await rendererGesture(main, locator, record, { grip, side, outcome, beforeRelease: async () => {
      assert.deepEqual(await nativeIds(app), before, "Crossing the client edge without releasing opened a child window");
      record.native_cursor_before_release = await nativePointer(app);
    } });
    record.native_cursor_after_release = await nativePointer(app);
    if (outcome !== "drop") {
      record.native_ids_after = await nativeIds(app);
      assert.deepEqual(record.native_ids_after, before, `${label}: native windows changed after a cancelled or unrelated gesture`);
      assert.equal(opened.length, 0, `${label}: Playwright observed a transient child`);
      record.status = "passed";
      return null;
    }
    const { content_bounds: content, bounds: parent } = mainWindow;
    const { released_at: release, main_client_size: client } = record;
    record.projected_application_drop_dip = { x: content.x + release.x * content.width / client.width,
      y: content.y + release.y * content.height / client.height };
    assert.ok(record.projected_application_drop_dip.x < parent.x || record.projected_application_drop_dip.x > parent.x + parent.width,
      "The renderer release must project beyond the windowed parent frame");
    const releasePoint = record.renderer_release_screen_dip;
    const slop = 2; // Native screen bounds and content geometry can round to adjacent DIPs.
    const near = (a, b, tolerance = slop) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
    assert.ok(near(releasePoint, record.projected_application_drop_dip),
      `${label}: the Chromium release screen point differs from the native content projection`);
    record.release_display = await app.evaluate(({ screen }, point) => {
      const display = screen.getDisplayNearestPoint(point);
      return { display_id: display.id, work_area: display.workArea };
    }, releasePoint);
    const child = await poll(async () => {
      for (const candidate of opened) {
        if (!candidate.isClosed() && (await nativeDetails(app, candidate).catch(() => null))?.title === title) return candidate;
      }
      return null;
    }, `native child ${title} after ${label}`, 20_000);
    record.native_child = await nativeDetails(app, child);
    record.native_ids_after = await nativeIds(app);
    assert.deepEqual(record.native_ids_after, [...before, record.native_child.id].sort((a, b) => a - b), `${label}: expected exactly one new native window`);
    assert.equal(opened.length, 1, `${label}: Playwright observed more than one new child`);
    const { work_area: area } = record.release_display;
    const bounds = record.native_child.bounds;
    assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width + slop
      && bounds.y + bounds.height <= area.y + area.height + slop, `${label}: child extends beyond the release display work area`);
    const placementFor = (point, workArea) => {
      const width = Math.min(bounds.width, workArea.width), height = Math.min(bounds.height, workArea.height);
      return {
        x: clamp(point.x - Math.min(96, Math.round(width / 2)), workArea.x, workArea.x + workArea.width - width),
        y: clamp(point.y - 18, workArea.y, workArea.y + workArea.height - height),
      };
    };
    const expected = placementFor(releasePoint, area);
    record.expected_native_origin_from_release = expected;
    assert.ok(near(bounds, expected), `${label}: child origin differs from the release anchor and work-area clamp`);
    const point = { x: clamp(releasePoint.x, area.x, area.x + area.width), y: clamp(releasePoint.y, area.y, area.y + area.height) };
    record.release_clamped_to_work_area = point;
    assert.ok(point.x >= bounds.x - slop && point.y >= bounds.y - slop && point.x <= bounds.x + bounds.width + slop
      && point.y <= bounds.y + bounds.height + slop, `${label}: the clamped release misses the child bounds`);
    const cursor = record.native_cursor_before_release;
    const observed = record.native_cursor_after_release;
    record.native_cursor_stable_during_release = cursor.display_id === observed.display_id && near(cursor.point, observed.point, 4);
    const cursorOrigins = [cursor, observed].map(sample => placementFor(sample.point, sample.work_area));
    record.expected_native_origin_from_cursor_samples = cursorOrigins;
    record.distinguishes_native_cursor_placement = record.native_cursor_stable_during_release
      && cursorOrigins.every(origin => !near(expected, origin, 2 * slop));
    record.status = "passed";
    return child;
  } catch (error) {
    record.status = "failed";
    throw error;
  } finally {
    app.off("window", listener);
  }
}
