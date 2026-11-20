import assert from "node:assert/strict";
import path from "node:path";

const dialogIn = (page) => page.getByRole("dialog", { name: "Settings", exact: true });

/** Settings belongs to the triggering workbench and blocks interaction in that document. */
export async function resolveSettings(app, workspace) {
  const dialog = dialogIn(workspace).and(workspace.locator("dialog.settings-shell:modal"));
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(app.windows().includes(workspace), "Settings must belong to the workbench window");
  return { page: workspace, dialog };
}

export async function openSettings(app, workspace, { trigger } = {}) {
  const windows = app.windows();
  await (trigger ?? workspace.getByRole("button", { name: "Open settings", exact: true })).click();
  const surface = await resolveSettings(app, workspace);
  assert.deepEqual(app.windows(), windows, "Opening Settings must not create a window");
  return surface;
}

async function awaitSettingsClose(settings, action) {
  await action();
  await settings.dialog.waitFor({ state: "hidden", timeout: 30_000 });
}

export async function closeSettings(settings, name = "Done") {
  return awaitSettingsClose(settings, () => settings.dialog.getByRole("button", { name, exact: true }).click());
}

export async function escapeSettings(settings) {
  return awaitSettingsClose(settings, () => settings.page.keyboard.press("Escape"));
}

/** Record real input and compositor frame swaps. Use pixel evidence to identify
 * the state in each frame, without app markers or locator/poll completion times. */
export async function measureSettingsPaint(app, page, samples = 6) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const onFrame = ({ data, metadata, sessionId }) => {
    if (Number.isFinite(metadata.timestamp)) frames.push({ data, swapMs: metadata.timestamp * 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", onFrame);
  try {
    await page.evaluate(() => {
      const probe = { input: [], stop: () => {} };
      const capture = event => {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        const control = event.target.closest("button");
        const action = control?.getAttribute("aria-label");
        if (action === "Open settings" || action === "Close settings") {
          probe.input.push({ action, type: event.type, epochMs: performance.timeOrigin + event.timeStamp });
        }
      };
      for (const event of ["pointerdown", "click"]) document.addEventListener(event, capture, true);
      probe.stop = () => {
        for (const event of ["pointerdown", "click"]) document.removeEventListener(event, capture, true);
        delete window.__lociSettingsPaint;
      };
      window.__lociSettingsPaint = probe;
    });
    const afterPaint = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const reference = async () => (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
    const closed = await reference();
    await cdp.send("Page.startScreencast", { format: "png", maxWidth: 600, maxHeight: 380, everyNthFrame: 1 });
    let opened;
    for (let sample = 0; sample < samples; sample++) {
      const settings = await openSettings(app, page);
      await afterPaint();
      if (sample === 0) opened = await reference();
      await closeSettings(settings, "Close settings");
      await afterPaint();
    }
    await cdp.send("Page.stopScreencast");
    const input = await page.evaluate(() => window.__lociSettingsPaint.input);
    assert.equal(input.length, samples * 4, "Every open/close must come from a trusted pointer activation");
    const classified = await page.evaluate(async ({ closed, opened, frames }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 60; canvas.height = 38;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const pixels = async data => {
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const distance = (a, b) => {
        let sum = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) sum += Math.abs(a[i + channel] - b[i + channel]);
        }
        return sum / (canvas.width * canvas.height * 3);
      };
      const before = await pixels(closed), after = await pixels(opened);
      const referenceDistance = distance(before, after);
      const observed = [];
      for (const { data, swapMs } of frames) {
        const actual = await pixels(data);
        const fromClosed = distance(actual, before), fromOpen = distance(actual, after);
        const state = Math.min(fromClosed, fromOpen) > referenceDistance * 0.4 ? "unknown"
          : fromOpen < fromClosed ? "open" : "closed";
        observed.push({ swapMs, state, fromClosed, fromOpen });
      }
      return { referenceDistance, observed };
    }, { closed, opened, frames });
    assert.ok(classified.referenceDistance > 2, "Settings and workspace reference frames must be visually distinguishable");
    const transitions = [];
    for (let i = 0; i < input.length; i += 2) {
      const [down, click, next] = input.slice(i, i + 3);
      const state = i % 4 === 0 ? "open" : "closed";
      assert.equal(down.type, "pointerdown");
      assert.equal(click.type, "click");
      assert.equal(click.action, state === "open" ? "Open settings" : "Close settings");
      assert.equal(down.action, click.action);
      const swapped = classified.observed.find(frame => frame.state === state &&
        frame.swapMs >= click.epochMs && frame.swapMs < (next?.epochMs ?? Infinity));
      assert.ok(swapped, `No composited Settings ${state} frame was captured for sample ${Math.floor(i / 4) + 1}`);
      transitions.push({ sample: Math.floor(i / 4) + 1, state,
        pointer_down_epoch_ms: down.epochMs, click_epoch_ms: click.epochMs, first_observed_swap_epoch_ms: swapped.swapMs,
        pointer_to_swap_ms: swapped.swapMs - down.epochMs, click_to_swap_ms: swapped.swapMs - click.epochMs });
    }
    return { method: "Trusted DOM event time and first matching CDP compositor swap (PNG pixels)",
      transitions, reference_distance: classified.referenceDistance, frame_count: frames.length };
  } finally {
    cdp.off("Page.screencastFrame", onFrame);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach();
    await page.evaluate(() => window.__lociSettingsPaint?.stop());
  }
}

/** Real control interaction, run after timed navigation so captures do not bias it. */
export async function checkSettingsAndManual(app, page, screenshots) {
  const settings = await openSettings(app, page);
  const { dialog } = settings;
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  const evidence = [];
  const themes = ["Graphite", "Midnight", "Paper", "Aurora", "Ember", "Lagoon"];
  if (await dialog.locator('option[value="black"]').count()) themes.push("Black");
  for (const theme of themes) {
    await dialog.getByRole("combobox", { name: "Application theme" }).selectOption(theme.toLowerCase());
    for (const size of ["Standard", "Large"]) {
      await dialog.getByRole("radio", { name: new RegExp(`^${size}`) }).click();
      await page.waitForFunction(({ theme, size }) => document.documentElement.dataset.theme === theme &&
        document.documentElement.dataset.textSize === size, { theme: theme.toLowerCase(), size: size.toLowerCase() });
      const geometry = await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const pane = element.querySelector('.settings-pane');
        const selected = [...element.querySelectorAll('[aria-checked="true"]')].map((control) => control.textContent);
        return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom,
          viewport: [innerWidth, innerHeight], dpi: devicePixelRatio,
          pane_overflow_x: pane.scrollWidth - pane.clientWidth, selected };
      });
      assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.viewport[0] &&
        geometry.bottom <= geometry.viewport[1], `${theme}/${size}: Settings leaves the window`);
      assert.ok(geometry.pane_overflow_x <= 1, `${theme}/${size}: Settings clips horizontally`);
      const file = path.join(screenshots, `settings-${theme.toLowerCase()}-${size.toLowerCase()}.png`);
      await dialog.screenshot({ path: file, animations: "disabled" });
      evidence.push({ theme, size, geometry, screenshot: file });
    }
  }
  await dialog.getByRole("combobox", { name: "Application theme" }).selectOption("graphite");
  await dialog.getByRole("radio", { name: /^Standard/ }).click();
  await dialog.getByRole("radio", { name: /^Reduce motion/ }).click();
  await dialog.getByRole("combobox", { name: "Interface font" }).selectOption("verdana");
  await page.waitForFunction(() => document.documentElement.dataset.font === "verdana");
  assert.match(await dialog.evaluate((element) => getComputedStyle(element).fontFamily), /Verdana/i);
  await dialog.getByRole("tab", { name: "Viewing & help" }).click();
  const navigator = dialog.getByRole("switch", { name: /^Overview navigator/ })
    .or(dialog.getByRole("checkbox", { name: /^Overview navigator/ }));
  assert.equal(await navigator.isChecked(), true);
  // The styled native checkbox intentionally delegates pointer activation to
  // its visible label. Exercise that real target, then the keyboard control.
  await dialog.locator("label.settings-toggle-row").filter({ hasText: "Overview navigator" }).click();
  assert.equal(await navigator.isChecked(), false, "The visible navigator label did not toggle its checkbox");
  await navigator.focus();
  await settings.page.keyboard.press("Space");
  assert.equal(await navigator.isChecked(), true, "Keyboard activation did not restore the navigator checkbox");
  await dialog.getByRole("tab", { name: "Saving & export" }).click();
  const dpi = dialog.getByRole("textbox", { name: "Default figure DPI" });
  await dpi.fill("600"); await dpi.press("Enter");
  await closeSettings(settings);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("loci.preferences.v1"))?.figureDpi === 600);
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem("loci.preferences.v1")));
  assert.equal(preferences.figureDpi, 600);
  assert.equal(preferences.font, "verdana");
  assert.equal(preferences.motion, "reduced");
  assert.equal(preferences.viewer.showNavigator, true);
  const transition = await page.locator('.workbench-tool-select__trigger').evaluate((element) => getComputedStyle(element).transitionDuration);
  assert.ok(transition.split(',').every((duration) => parseFloat(duration) === 0), "Reduced motion still has timed menu transitions");
  await page.getByRole("button", { name: "Save study", exact: true }).hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Close tip", exact: true }).click();
  await tip.waitFor({ state: "hidden" });
  await page.keyboard.press("F1");
  const manual = page.getByRole("dialog", { name: "User manual", exact: true });
  const search = manual.getByRole("searchbox", { name: "Search user manual" });
  await search.fill("histogram");
  assert.ok(await manual.getByRole("navigation", { name: "Manual contents" }).getByRole("button").count() > 0);
  const manualFile = path.join(screenshots, "offline-user-manual.png");
  await manual.screenshot({ path: manualFile, animations: "disabled" });
  await search.fill("no-matching-workflow-xyz");
  await manual.getByRole("status").filter({ hasText: "No matching section" }).waitFor();
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  await page.keyboard.press("Escape");
  await manual.waitFor({ state: "hidden" });
  return { themes: evidence, preferences, reduced_motion_transition: transition, manual_screenshot: manualFile };
}
