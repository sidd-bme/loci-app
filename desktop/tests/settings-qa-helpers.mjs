import assert from "node:assert/strict";
import path from "node:path";

const dialogIn = (page) => page.getByRole("dialog", { name: "Settings", exact: true });

/** Resolve the dedicated Settings page, or the explicitly supported inline fallback. */
export async function resolveSettings(app, workspace, { requireNative = false } = {}) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    for (const page of app.windows()) {
      if (page === workspace || page.isClosed() ||
          !await page.evaluate(() => Boolean(window.lociSettings)).catch(() => false)) continue;
      const dialog = dialogIn(page);
      await dialog.waitFor({ state: "visible", timeout: Math.max(1, deadline - performance.now()) });
      return { page, dialog, native: true };
    }
    const dialog = dialogIn(workspace);
    if (!requireNative && await dialog.isVisible()) return { page: workspace, dialog, native: false };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(requireNative ? "The dedicated Settings window did not open." : "Settings did not open.");
}

export async function openSettings(app, workspace, { requireNative = false, trigger } = {}) {
  await (trigger ?? workspace.getByRole("button", { name: "Open settings", exact: true })).click();
  return resolveSettings(app, workspace, { requireNative });
}

async function awaitSettingsClose(settings, action) {
  if (settings.native) {
    await Promise.all([settings.page.waitForEvent("close", { timeout: 30_000 }),
      action().catch(error => { if (!settings.page.isClosed()) throw error; })]);
  } else {
    await action();
    await settings.dialog.waitFor({ state: "hidden", timeout: 30_000 });
  }
}

export async function closeSettings(settings, name = "Done") {
  return awaitSettingsClose(settings, () => settings.dialog.getByRole("button", { name, exact: true }).click());
}

export async function escapeSettings(settings) {
  return awaitSettingsClose(settings, () => settings.page.keyboard.press("Escape"));
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
  const search = manual.getByRole("textbox", { name: "Search user manual" });
  await search.fill("histogram");
  assert.ok(await manual.getByRole("navigation", { name: "Manual contents" }).getByRole("button").count() > 0);
  const manualFile = path.join(screenshots, "offline-user-manual.png");
  await manual.screenshot({ path: manualFile, animations: "disabled" });
  await search.fill("no-matching-workflow-xyz");
  await manual.getByRole("status").filter({ hasText: "No matching section" }).waitFor();
  await page.keyboard.press("Escape");
  await manual.waitFor({ state: "hidden" });
  return { themes: evidence, preferences, reduced_motion_transition: transition, manual_screenshot: manualFile };
}
