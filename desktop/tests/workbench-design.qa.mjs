import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

// Presentation qualification only. Analysis/result-integrity journeys remain
// the authority for numerical behavior; this harness never inserts results.
const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const appInput = process.env.LOCI_PACKAGED_APP ?? process.env.LOCI_QA_APP;
assert.ok(appInput && path.isAbsolute(appInput), "Set LOCI_PACKAGED_APP to an absolute Loci.app path.");
assert.ok(!process.env.LOCI_QA_DEV, "This journey requires a packaged application.");
assert.ok(!process.env.LOCI_PACKAGED_APP || !process.env.LOCI_QA_APP ||
  process.env.LOCI_PACKAGED_APP === process.env.LOCI_QA_APP, "Packaged app aliases disagree.");
assert.equal(process.platform, "darwin", "This journey currently supports packaged macOS applications.");
const appPath = path.resolve(appInput);
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ??
  path.join(projectRoot, ".loci/evidence/qa/workbench-design"));
const runRoot = path.join(outputRoot, new Date().toISOString().replaceAll(/[:.]/g, "-"));
const screenshotsRoot = path.join(runRoot, "screenshots");
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const fixturePath = path.join(fixtureRoot, "design-control-stack.ome.tiff");
const studyPath = path.join(runRoot, "design-regression.loci-study");
const userDataPath = path.join(runRoot, "user-data");
const pythonPath = path.join(projectRoot, "engine/.venv/bin/python");
const artifacts = {
  executable: path.join(appPath, "Contents/MacOS/Loci"),
  asar: path.join(appPath, "Contents/Resources/app.asar"),
  worker: path.join(appPath, "Contents/Resources/loci-engine/loci-engine"),
};
const themes = ["graphite", "midnight", "paper", "aurora", "ember", "lagoon", "fiji"];
const sizes = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const categories = ["Appearance", "Viewing & help", "Saving & export", "Capabilities", "User guide"];
const startedAt = new Date().toISOString();
const captures = {};
const steps = [];
const geometry = [];
const toolCoverage = [];
const tokenContrast = {};
const detachedCoverage = [];
const nativeFileCoverage = [];
const disclosureCoverage = [];
const resizeCoverage = [];
const renderer = { page_errors: [], console_errors: [] };
let app, page, cdp, buildIdentity, sourceIdentity, fixtureIdentity, activeStep;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function identifyBuild() {
  return Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([key, file]) =>
    [key, { path: file, sha256: await sha256(file) }])));
}
async function capture(name, waitForReady = true, target = page) {
  // A tab selection may remount the viewer before its next paint. Bind captures
  // to the real viewer readiness marker, then allow layout and paint to settle.
  const viewer = target.locator(".image-viewport").filter({ visible: true }).first();
  if (waitForReady && await target.locator("main.research-workbench").count() &&
      await target.locator('[aria-label="Active image"]').count()) {
    // Do not mistake a brief remount gap for a surface without an image.
    await target.locator('.image-viewport[data-prepared="true"]').waitFor({ state: "visible", timeout: 60_000 });
  }
  if (waitForReady && await viewer.count()) {
    await target.waitForFunction(() => [...document.querySelectorAll(".image-viewport")]
      .filter((element) => element.getClientRects().length)
      .every((element) => element.dataset.prepared === "true" &&
        element.querySelector("canvas")?.width > 0 && element.querySelector("canvas")?.height > 0),
    undefined, { timeout: 60_000 });
  }
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const file = path.join(screenshotsRoot, `${name}.png`);
  const bytes = await target.screenshot({ path: file, animations: "disabled", scale: "css" });
  captures[name] = { file: path.relative(runRoot, file), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const current = steps.at(-1);
  if (current?.status === "running") current.evidence.push({ name, screenshot: captures[name] });
  return captures[name];
}
async function assertNoUiError(label) {
  assert.equal(renderer.page_errors.length, 0, `${label}: renderer exception`);
  const errors = page.locator(".research-alert[role=alert], .error-banner[role=alert]").filter({ visible: true });
  assert.equal(await errors.count(), 0, `${label}: ${await errors.allTextContents()}`);
}
async function audit(name, target = page) {
  const result = await target.evaluate(() => {
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height,
        right: value.right, bottom: value.bottom };
    };
    const visible = (element) => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden";
    const inspector = document.querySelector(".research-inspector");
    let scrolling = null;
    if (inspector) {
      const prior = inspector.scrollTop;
      inspector.scrollTop = inspector.scrollHeight;
      const reached = inspector.scrollTop;
      inspector.scrollTop = prior;
      scrolling = { ...rect(inspector), client_height: inspector.clientHeight,
        scroll_height: inspector.scrollHeight, scroll_width: inspector.scrollWidth,
        client_width: inspector.clientWidth, overflow_y: getComputedStyle(inspector).overflowY,
        reached_scroll_top: reached };
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
      theme: document.documentElement.dataset.theme,
      text_size: document.documentElement.dataset.textSize,
      root_width: document.documentElement.clientWidth,
      root_scroll_width: document.documentElement.scrollWidth,
      body_scroll_width: document.body.scrollWidth,
      inspector: scrolling,
      overlays: [...document.querySelectorAll('[role="dialog"], [role="listbox"], details.workbench-file-menu[open] > div, details.source-information[open] > .source-information-content, .context-tooltip')]
        .filter(visible).map((element) => ({ role: element.getAttribute("role") ?? "popover",
          label: element.getAttribute("aria-label") ?? element.className, ...rect(element) })),
      task_buttons: [...document.querySelectorAll('[aria-label="Task groups"] button')]
        .filter(visible).map((element) => ({ text: element.textContent.trim(), ...rect(element) })),
    };
  });
  geometry.push({ name, ...result });
  assert.ok(result.root_scroll_width <= result.viewport.width + 1, `${name}: horizontal root overflow`);
  assert.ok(result.body_scroll_width <= result.viewport.width + 1, `${name}: horizontal body overflow`);
  for (const overlay of result.overlays) {
    assert.ok(overlay.width > 0 && overlay.height > 0 && overlay.x >= -1 && overlay.y >= -1 &&
      overlay.right <= result.viewport.width + 1 && overlay.bottom <= result.viewport.height + 1,
    `${name}: offscreen ${overlay.role} ${overlay.label ?? ""}`);
  }
  for (const button of result.task_buttons) assert.ok(button.x >= -1 && button.y >= -1 &&
    button.right <= result.viewport.width + 1 && button.bottom <= result.viewport.height + 1,
  `${name}: inaccessible task group ${button.text}`);
  if (result.inspector) {
    const region = result.inspector;
    assert.ok(region.width > 0 && region.height > 0, `${name}: inspector has no usable area`);
    assert.ok(region.scroll_width <= region.client_width + 1, `${name}: horizontal inspector overflow`);
    if (region.scroll_height > region.client_height + 1) {
      assert.ok(["auto", "scroll"].includes(region.overflow_y) && region.reached_scroll_top > 0,
        `${name}: overflowing inspector cannot scroll`);
    }
  }
  return result;
}
async function auditTokenContrast() {
  return page.evaluate(() => {
    const foregrounds = ["ink", "ink-secondary", "ink-muted", "mineral-bright"];
    const backgrounds = ["graphite-900", "graphite-925", "graphite-850"];
    const probe = document.createElement("span");
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    document.body.append(probe);
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const sample = (css) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const tokens = {};
    try {
      const rootStyle = getComputedStyle(document.documentElement);
      for (const token of [...foregrounds, ...backgrounds]) {
        probe.style.color = `var(--${token})`;
        const computed = getComputedStyle(probe).color;
        tokens[token] = { raw_css: rootStyle.getPropertyValue(`--${token}`).trim(),
          computed_css: computed, rgba: sample(computed) };
      }
      const composite = (rgba, below) => rgba.slice(0, 3).map((value, index) =>
        value * rgba[3] / 255 + below[index] * (1 - rgba[3] / 255));
      const root = composite(sample(rootStyle.backgroundColor), [255, 255, 255]);
      const luminance = (rgb) => rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
      const pairs = [];
      for (const foreground of foregrounds) for (const background of backgrounds) {
        if (foreground === "mineral-bright" && background !== "graphite-900") continue;
        const renderedBackground = composite(tokens[background].rgba, root);
        const renderedForeground = composite(tokens[foreground].rgba, renderedBackground);
        const a = luminance(renderedForeground), b = luminance(renderedBackground);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        pairs.push({ foreground, background, contrast: Number(ratio.toFixed(4)),
          below_4_5: ratio < 4.5, rendered_foreground_rgb: renderedForeground,
          rendered_background_rgb: renderedBackground });
      }
      return { theme: document.documentElement.dataset.theme, tokens, pairs,
        below_4_5: pairs.filter((pair) => pair.below_4_5),
        method: "WCAG relative luminance; actual browser-resolved tokens sampled in sRGB and alpha-composited",
        interpretation: "Reported for lead review; subdued and disabled contexts are not automatically failed." };
    } finally { probe.remove(); }
  });
}

async function step(name, action) {
  activeStep = name;
  const entry = { name, started_at: new Date().toISOString(), status: "running", evidence: [] };
  steps.push(entry);
  try {
    await action();
    await assertNoUiError(name);
    await audit(name);
    // Deliberate open/error/focus evidence is the primary step artifact. The
    // post-cleanup view is separately named and never overwrites that evidence.
    const deliberate = [...entry.evidence];
    entry.settled_screenshot = await capture(`${name}-settled`);
    entry.screenshot = deliberate.at(-1)?.screenshot ?? entry.settled_screenshot;
    entry.status = "passed";
    entry.completed_at = new Date().toISOString();
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    entry.screenshot = await capture(`${name}-failure`, false).catch(() => null);
    throw error;
  }
}
async function nativeMenu(top, label) {
  await app.evaluate(({ Menu, BrowserWindow, app: runtime }, request) => {
    const menu = Menu.getApplicationMenu();
    const parent = menu?.items.find((item) => item.label === (request.top === "app" ? runtime.name : request.top));
    const item = parent?.submenu?.items.find((candidate) => candidate.label === request.label);
    if (!item || !item.enabled || typeof item.click !== "function") throw new Error(`Native menu unavailable: ${request.top}/${request.label}`);
    item.click(item, BrowserWindow.getFocusedWindow(), {});
  }, { top, label });
}
function sourceBindings(snapshot) {
  return snapshot.sources.map(({ id, sha256 }) => ({ id, sha256 }));
}
function assertFixtureBindings(snapshot, previous = []) {
  assert.ok(snapshot.sources.length > 0, "The fixture study must contain an image");
  assert.ok(snapshot.sources.every((source) => source.sha256 === fixtureIdentity.sha256 &&
    source.locator_state !== "relink-required"), "Every image must retain its accessible generated-fixture binding");
  for (const binding of previous) assert.ok(snapshot.sources.some((source) =>
    source.id === binding.id && source.sha256 === binding.sha256), "Existing source identity must survive the native File command");
  assert.equal(snapshot.results.length, 0, "Native File qualification must not fabricate scientific results");
}
async function nativeFile(label, kind, title) {
  const count = await app.evaluate(() => globalThis.__lociDesignQaDialogs.length);
  await nativeMenu("File", label);
  const deadline = Date.now() + 30_000;
  let calls = [];
  while (Date.now() < deadline) {
    calls = await app.evaluate((_, start) => globalThis.__lociDesignQaDialogs.slice(start), count);
    if (calls.length) break;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(calls, [{ kind, title }], `Native ${label} must use the research picker`);
  // The real document-switch wrapper commits its busy state before invoking
  // a native dialog. Its visible Local state and prepared viewer mark return.
  await page.waitForFunction(() => document.querySelector('.workbench-status [role="status"]')?.textContent === "Local");
  await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { command: `File/${label.replace("…", "")}`, picker: { kind, title } };
}
async function resize({ width, height }) {
  // macOS may constrain native windows to the connected monitor. Preserve that
  // observation, then use a labelled renderer viewport for the larger-monitor
  // case; the same packaged Electron UI and scientific transport still run.
  if (!cdp) cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, { width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const native = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { bounds: window.getBounds(), content_size: window.getContentSize(),
      display_work_area: screen.getDisplayMatching(window.getBounds()).workArea };
  });
  const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio }));
  const constrained = native.content_size[0] !== width || native.content_size[1] !== height;
  if (constrained) await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false,
  });
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, { width, height });
  const after = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio }));
  resizeCoverage.push({ requested: { width, height }, native, renderer_before: before, renderer_after: after,
    mode: constrained ? "simulated-larger-monitor-renderer-viewport" : "native-content-resize",
    emulation: constrained ? "CDP Emulation.setDeviceMetricsOverride; deviceScaleFactor=1; mobile=false" : null });
}
async function settings() {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
}
async function appearance(theme, textSize) {
  await settings();
  await page.getByRole("combobox", { name: "Application theme", exact: true }).selectOption(theme);
  await page.getByRole("radio", { name: textSize === "large" ? "Large" : "Standard", exact: true }).click();
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value.theme &&
    document.documentElement.dataset.textSize === value.textSize, { theme, textSize });
  await page.getByRole("button", { name: "Done", exact: true }).click();
}
async function selectTool(group, label) {
  await page.getByRole("navigation", { name: "Task groups" }).getByRole("button", { name: group, exact: true }).click();
  await page.getByRole("combobox", { name: `${group} tool`, exact: true }).click();
  await page.getByRole("listbox", { name: `${group} tool`, exact: true }).getByRole("option", { name: label, exact: true }).click();
  await page.getByRole("combobox", { name: `${group} tool`, exact: true }).filter({ hasText: label }).waitFor();
}
async function imageWindowState() {
  return page.evaluate(() => window.lociImageWindows.state());
}
async function findImagePage(viewId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate === page || candidate.isClosed()) continue;
      const state = await candidate.evaluate(() => window.lociImageWindows?.state()).catch(() => null);
      if (state?.target?.viewId === viewId) return candidate;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Detached image window did not become available: ${viewId}`);
}
async function detachFixture(label) {
  await selectTool("View", "Image & channels");
  await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
  const sourceId = await page.locator(".image-viewport").getAttribute("data-viewer-source");
  await page.getByRole("button", { name: "Detach image", exact: true }).click();
  await page.getByRole("heading", { name: "Image controls", exact: true }).waitFor();
  await page.waitForFunction(async () => (await window.lociImageWindows.state()).views.length === 1);
  const state = await imageWindowState();
  const entry = state.views[0];
  assert.equal(entry.target.sourceId, sourceId, "Detached target must remain source-bound");
  assert.equal(entry.target.sourceSha256, fixtureIdentity.sha256);
  assert.equal(entry.source.sha256, fixtureIdentity.sha256);
  const image = await findImagePage(entry.target.viewId);
  await image.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
  await audit(`${label}-image-window`, image);
  await capture(`${label}-image-window`, true, image);
  await capture(`${label}-control-panel`);
  return { image, entry };
}
async function assertReturnedImage(sourceId) {
  await page.locator("main.research-workbench").waitFor();
  await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
  assert.equal((await imageWindowState()).views.length, 0, "Native return must revoke child views");
  assert.equal(await page.locator(".image-viewport").getAttribute("data-viewer-source"), sourceId,
    "Returning must restore the active source");
}

async function closeApp() {
  if (!app) return;
  const closing = app;
  await closing.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  // Same clean quit path as existing journeys; a hung process is force-closed
  // through Playwright only after the bounded normal exit fails.
  try {
    await Promise.all([
      closing.waitForEvent("close", { timeout: 30_000 }),
      closing.evaluate(({ app: runtime }) => { setTimeout(() => runtime.quit(), 0); }),
    ]);
  } catch (error) {
    await closing.close().catch(() => undefined);
    throw error;
  } finally { app = undefined; page = undefined; }
}

try {
  await Promise.all([fs.mkdir(screenshotsRoot, { recursive: true }), fs.mkdir(fixtureRoot, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }), fs.access(pythonPath), ...Object.values(artifacts).map((file) => fs.access(file))]);
  const generator = path.join(runRoot, "generate_design_fixture.py");
  await fs.writeFile(generator, String.raw`from pathlib import Path
import sys
import numpy as np
import tifffile
output = Path(sys.argv[1])
y, x = np.ogrid[:96, :128]
frames = []
for t in range(2):
    frames.append(np.stack([((x * 17 + y * 31 + t * 211) % 4096).astype(np.uint16),
                            ((x * 41 + y * 13 + t * 307) % 4096).astype(np.uint16)]))
image = np.stack(frames)
tifffile.imwrite(output, image, ome=True, metadata={"axes": "TCYX",
    "Channel": {"Name": ["Synthetic A", "Synthetic B"]},
    "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm",
    "PhysicalSizeY": 0.5, "PhysicalSizeYUnit": "µm"})
`);
  await run(pythonPath, [generator, fixturePath], { timeout: 60_000 });
  fixtureIdentity = { path: fixturePath, sha256: await sha256(fixturePath), generator_sha256: await sha256(generator),
    synthetic_non_biological: true, axes: "TCYX", shape: [2, 2, 96, 128] };
  buildIdentity = await identifyBuild();
  const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = { head: await git("rev-parse", "HEAD"), head_tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"), harness_sha256: await sha256(import.meta.filename) };
  app = await electron.launch({ executablePath: artifacts.executable,
    args: [`--user-data-dir=${userDataPath}`], cwd: desktopRoot, timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const watched = new WeakSet();
  const watch = (target) => {
    if (watched.has(target)) return;
    watched.add(target);
    target.on("pageerror", (error) => renderer.page_errors.push(error.message));
    target.on("console", (message) => { if (message.type() === "error") renderer.console_errors.push(message.text()); });
  };
  watch(page); app.on("window", watch);
  await page.locator("main.image-first-empty, main.research-workbench").waitFor({ timeout: 30_000 });
  await app.evaluate(({ dialog }, values) => {
    globalThis.__lociDesignQaDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      globalThis.__lociDesignQaDialogs.push({ kind: "open", title });
      if (title === "Add microscopy or medical images") return { canceled: false, filePaths: [values.fixture] };
      if (title === "Select a folder of research images") return { canceled: false, filePaths: [values.folder] };
      if (title === "Open research study") return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      globalThis.__lociDesignQaDialogs.push({ kind: "save", title });
      return title === "Save research study as" ? { canceled: false, filePath: values.study } : { canceled: true };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { fixture: fixturePath, folder: fixtureRoot, study: studyPath });

  await resize(sizes[0]);
  await step("01-native-help", async () => {
    await nativeMenu("Help", "User guide");
    const guide = page.getByRole("dialog", { name: "User manual", exact: true });
    await guide.waitFor();
    await guide.getByRole("textbox", { name: "Search user manual" }).fill("qa-no-such-workflow-78291");
    await guide.getByRole("status").filter({ hasText: "No matching section" }).waitFor();
    await audit("native-guide-no-results");
    await capture("native-guide-no-results");
    await page.keyboard.press("Escape");
    await guide.waitFor({ state: "hidden" });
  });
  await step("02-native-settings", async () => {
    await nativeMenu("app", "Settings…");
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
    await audit("native-settings-dialog"); await capture("native-settings-dialog");
    await page.keyboard.press("Escape");
  });
  await step("03-native-open-images-research-route", async () => {
    await nativeMenu("File", "Open images…");
    await page.waitForFunction(async () => (await window.lociResearch.getSnapshot())?.sources?.length === 1);
    await page.locator("main.research-workbench").waitFor();
    await page.getByRole("combobox", { name: "View tool", exact: true }).waitFor();
    const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    assert.equal(snapshot.sources[0].sha256, fixtureIdentity.sha256, "Native Open images must bind generated source bytes in research workspace");
    const calls = await app.evaluate(() => globalThis.__lociDesignQaDialogs);
    assert.deepEqual(calls.filter((item) => item.kind === "open").map((item) => item.title), ["Add microscopy or medical images"]);
    nativeFileCoverage.push({ command: "File/Open images", picker: { kind: "open", title: "Add microscopy or medical images" },
      source_bindings: sourceBindings(snapshot) });
  });

  await step("04-visible-synthetic-display-auto", async () => {
    const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    const source = snapshot.sources[0];
    await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
    await page.locator(".source-channel-heading").getByRole("button", { name: "Auto", exact: true }).click();
    const defaults = await page.evaluate((source_id) => window.lociResearch.execute("viewer_defaults", {
      source_id, t: 0, z: 0, auto: true,
    }), source.id);
    assert.equal(defaults.source_sha256, fixtureIdentity.sha256);
    await page.waitForFunction((expected) => expected.every((channel) => {
      const low = document.querySelector(`[aria-label="Channel ${channel.channel + 1} low"]`);
      const high = document.querySelector(`[aria-label="Channel ${channel.channel + 1} high"]`);
      return low && high && Number(low.value) === channel.low && Number(high.value) === channel.high;
    }), defaults.channels);
    await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
    assert.equal(await sha256(fixturePath), fixtureIdentity.sha256, "Auto display must preserve synthetic source bytes");
    disclosureCoverage.push({ name: "visible-synthetic-auto-display", status: "passed", source_id: source.id,
      source_sha256: source.sha256, display_ranges: defaults.channels.map(({ channel, low, high }) => ({ channel, low, high })) });
  });

  await step("header-file-menu", async () => {
    const menu = page.locator("details.workbench-file-menu");
    await menu.locator(":scope > summary").click();
    assert.equal(await menu.evaluate((element) => element.open), true);
    await menu.getByRole("button", { name: "Open study", exact: true }).waitFor({ state: "visible" });
    await audit("header-file-menu-open"); await capture("header-file-menu-open");
    await menu.locator(":scope > summary").press("Escape");
    assert.equal(await menu.evaluate((element) => element.open), false);
    assert.equal(await menu.locator(":scope > summary").evaluate((element) => element === document.activeElement), true);
  });
  await step("image-info-popover", async () => {
    const information = page.locator("details.source-information");
    await information.locator(":scope > summary").click();
    await information.getByRole("button", { name: "Close image information", exact: true }).waitFor();
    assert.equal(await information.evaluate((element) => element.open), true);
    await audit("image-information-open"); await capture("image-information-open");
    await information.locator(":scope > summary").press("Escape");
    assert.equal(await information.evaluate((element) => element.open), false);
    assert.equal(await information.locator(":scope > summary").evaluate((element) => element === document.activeElement), true);
  });
  await step("scalar-channel-disclosure", async () => {
    const channel = page.locator("details.source-channel").first();
    if (!await channel.count()) {
      disclosureCoverage.push({ name: "scalar-channel", status: "skipped", reason: "The current source has no scalar channel disclosure." });
      return;
    }
    const visibleBefore = await channel.getByRole("checkbox", { name: "Channel 1 visible", exact: true }).isChecked();
    if (!await channel.evaluate((element) => element.open)) await channel.locator(":scope > summary").click();
    await channel.getByLabel("Channel 1 low", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await channel.getByRole("checkbox", { name: "Channel 1 visible", exact: true }).isChecked(), visibleBefore,
      "Opening a channel disclosure must not change channel visibility");
    disclosureCoverage.push({ name: "scalar-channel", status: "passed" });
  });
  await step("scalar-native-histogram", async () => {
    const histogram = page.locator("details.source-channel").first().locator("details.source-histogram-disclosure");
    if (!await histogram.count()) {
      disclosureCoverage.push({ name: "native-histogram", status: "skipped", reason: "No native histogram disclosure is offered for this source." });
      return;
    }
    if (!await histogram.evaluate((element) => element.open)) await histogram.locator(":scope > summary").click();
    await page.waitForFunction(() => {
      const node = document.querySelector("details.source-channel details.source-histogram-disclosure .source-histogram-basis");
      return node && !node.textContent.includes("Reading a stable image sample");
    }, undefined, { timeout: 30_000 });
    const basis = await histogram.locator(".source-histogram-basis").textContent();
    if (basis.includes("unavailable") || basis.includes("Pause playback")) {
      disclosureCoverage.push({ name: "native-histogram", status: "skipped", reason: basis });
    } else {
      await histogram.getByRole("img", { name: "Channel 1 histogram", exact: true }).waitFor({ state: "visible" });
      assert.ok(basis.includes("Native scalar values") && basis.includes("samples per component"));
      disclosureCoverage.push({ name: "native-histogram", status: "passed", basis });
    }
    await histogram.scrollIntoViewIfNeeded(); await capture("scalar-histogram-open");
    await histogram.locator(":scope > summary").click();
    await page.locator("details.source-channel").first().locator(":scope > summary").click();
  });
  await step("analysis-region-disclosure", async () => {
    const region = page.locator("details.analysis-region-settings");
    if (!await region.evaluate((element) => element.open)) await region.locator(":scope > summary").click();
    for (const label of ["X", "Y", "Width", "Height", "C"])
      await region.getByLabel(label, { exact: true }).waitFor({ state: "visible" });
    await region.scrollIntoViewIfNeeded(); await capture("analysis-region-open");
    await region.locator(":scope > summary").click();
  });
  await step("rendered-export-disclosure-invalid-dpi", async () => {
    const panel = page.locator("details.source-export");
    await panel.locator(":scope > summary").click();
    const dpi = panel.getByRole("textbox", { name: "Rendered export DPI", exact: true });
    await dpi.waitFor({ state: "visible" });
    const before = await dpi.inputValue();
    const exportButton = panel.getByRole("button", { name: "Export PNG…", exact: true });
    assert.equal(await exportButton.isEnabled(), true);
    await panel.scrollIntoViewIfNeeded(); await capture("rendered-export-open");
    await dpi.fill("invalid export draft");
    assert.equal(await exportButton.isEnabled(), false);
    assert.equal(await dpi.getAttribute("aria-invalid"), "true");
    await panel.getByRole("alert").filter({ hasText: "Enter a whole number" }).waitFor();
    await capture("rendered-export-invalid-dpi");
    await dpi.press("Escape");
    assert.equal(await dpi.inputValue(), before);
    assert.equal(await dpi.getAttribute("aria-invalid"), "false");
    assert.equal(await exportButton.isEnabled(), true);
    await panel.locator(":scope > summary").click();
    disclosureCoverage.push({ name: "rendered-export-dpi", status: "passed", export_executed: false });
  });
  await step("tool-selector-keyboard-focus", async () => {
    await page.keyboard.press("Tab");
    const trigger = page.getByRole("combobox", { name: "View tool", exact: true });
    await trigger.focus();
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    await capture("tool-selector-keyboard-focus-ring");
  });
  await step("configured-contextual-hover-help", async () => {
    const enabled = await page.evaluate(() => {
      const saved = localStorage.getItem("loci.preferences.v1");
      return !saved || JSON.parse(saved).viewer?.contextualHelp !== false;
    });
    if (!enabled) {
      disclosureCoverage.push({ name: "contextual-help", status: "skipped", reason: "Contextual guidance is disabled in this test session's preferences." });
      return;
    }
    const control = page.getByRole("button", { name: "Open settings", exact: true });
    const expected = await control.getAttribute("data-loci-help") || await control.getAttribute("title");
    assert.ok(expected, "The labelled hover control must carry actual contextual help");
    await control.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await tooltip.textContent(), expected);
    assert.equal(await control.getAttribute("aria-describedby"), await tooltip.getAttribute("id"));
    await capture("contextual-help-visible");
    await audit("contextual-help-visible");
    await page.keyboard.press("Escape");
    await tooltip.waitFor({ state: "hidden" });
    disclosureCoverage.push({ name: "contextual-help", status: "passed", tooltip_text: expected });
  });

  await step("native-resize-menu-anchor", async () => {
    await resize({ width: 1600, height: 800 });
    const trigger = page.getByRole("combobox", { name: "View tool", exact: true });
    await trigger.click();
    await page.keyboard.press("Escape");
    await resize(sizes[0]);
    await trigger.click();
    // First observable open state must use the current anchor, without waiting
    // for the old offscreen position to repair itself after paint.
    const anchor = await page.evaluate(() => {
      const trigger = document.querySelector(".workbench-tool-select__trigger").getBoundingClientRect();
      const popup = document.querySelector(".workbench-tool-select__popup").getBoundingClientRect();
      return { viewport: innerWidth, trigger_left: trigger.left, popup_left: popup.left, popup_right: popup.right };
    });
    assert.ok(anchor.popup_left >= 8 && anchor.popup_right <= anchor.viewport - 8,
      `Reopened menu retained stale coordinates: ${JSON.stringify(anchor)}`);
    await capture("native-resize-menu-current-anchor");
    await audit("native-resize-menu-current-anchor");
    disclosureCoverage.push({ name: "native-resize-menu-anchor", status: "passed", ...anchor });
    await page.keyboard.press("Escape");
  });

  for (const size of sizes) {
    await resize(size);
    for (const theme of themes) for (const textSize of ["standard", "large"]) {
      await step(`matrix-${size.width}x${size.height}-${theme}-${textSize}`, async () => {
        await appearance(theme, textSize);
        if (!tokenContrast[theme]) tokenContrast[theme] = await auditTokenContrast();
        await selectTool("View", "Image & channels");
        assert.equal(await page.getByRole("button", { name: "Open settings", exact: true }).isEnabled(), true);
      });
    }
  }
  await resize(sizes[0]); await appearance("graphite", "large");
  for (const category of categories) await step(`settings-${category.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`, async () => {
    await settings();
    await page.getByRole("tab", { name: category, exact: true }).click();
    await page.getByRole("tabpanel", { name: category, exact: true }).waitFor();
    if (category === "Saving & export") {
      const dpi = page.getByRole("textbox", { name: "Default figure DPI", exact: true });
      await dpi.fill("invalid draft"); await dpi.press("Enter");
      assert.equal(await dpi.inputValue(), "invalid draft");
      assert.equal(await dpi.getAttribute("aria-invalid"), "true");
      await page.getByRole("alert").filter({ hasText: "Enter a whole number" }).waitFor();
      await capture("dpi-invalid-draft");
      await dpi.press("Escape");
      assert.equal(await dpi.inputValue(), "300");
      assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).isVisible(), true);
    }
    await audit(`settings-${category}-dialog`); await capture(`settings-${category.replaceAll(/[^a-zA-Z]+/g, "-")}-dialog`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
  });

  for (const group of ["View", "Annotate", "Analyze", "Results"]) {
    await page.getByRole("navigation", { name: "Task groups" }).getByRole("button", { name: group, exact: true }).click();
    const trigger = page.getByRole("combobox", { name: `${group} tool`, exact: true });
    await trigger.click();
    const options = await page.getByRole("listbox", { name: `${group} tool`, exact: true }).getByRole("option").evaluateAll((items) =>
      items.map((item) => ({ label: item.querySelector("span")?.textContent?.trim() || item.getAttribute("aria-label"),
        disabled: item.getAttribute("aria-disabled") === "true" || item.disabled,
        reason: item.getAttribute("title") || item.getAttribute("data-loci-help") })));
    await audit(`tools-${group}-popover`); await capture(`tools-${group}-popover`);
    await page.keyboard.press("Escape");
    for (const option of options) {
      assert.ok(option.label?.trim(), `${group}: option has no visible label`);
      toolCoverage.push({ group, ...option });
      if (option.disabled) { assert.ok(option.reason?.trim(), `${option.label}: disabled tool has no prerequisite reason`); continue; }
      await step(`tool-${option.label.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`, () => selectTool(group, option.label));
    }
  }
  assert.equal(toolCoverage.length, 16, "Every current primary and advanced tool must remain discoverable");
  for (const advanced of ["Connect an assistant", "Remote compute", "Import & share results", "Convert vendor images"])
    assert.ok(toolCoverage.some((item) => item.label === advanced && !item.disabled), `Missing advanced tool: ${advanced}`);

  await step("search-keyboard-no-results", async () => {
    await page.getByRole("button", { name: "Search all tools", exact: true }).click();
    const input = page.getByRole("combobox", { name: "Search all tools", exact: true });
    await input.fill("qa-no-such-tool-78291");
    await page.getByRole("status").filter({ hasText: "No tools match" }).waitFor();
    await audit("tool-search-no-results"); await capture("tool-search-no-results");
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    assert.equal(await input.inputValue(), "");
    await input.fill("Preprocess"); await input.press("ArrowDown");
    assert.ok(await input.getAttribute("aria-activedescendant"), "Keyboard search must expose its active tool");
    await input.press("Enter");
    await page.getByRole("combobox", { name: "Analyze tool", exact: true }).filter({ hasText: "Preprocess" }).waitFor();
    await page.getByRole("button", { name: "Search all tools", exact: true }).click();
    await page.getByRole("combobox", { name: "Search all tools", exact: true }).press("Escape");
    assert.equal(await page.getByRole("button", { name: "Search all tools", exact: true }).evaluate((element) => element === document.activeElement), true);
  });
  await resize({ width: 1100, height: 720 });
  await step("compact-large-text-dense-inspector", async () => {
    await selectTool("Analyze", "Fluorescence & field assay");
    await page.getByRole("heading", { name: "Channel identities", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const inspector = document.querySelector(".research-inspector");
      return inspector && inspector.scrollHeight > inspector.clientHeight;
    });
    const region = await audit("dense-inspector-scroll");
    assert.ok(region.inspector?.scroll_height > region.inspector?.client_height,
      "Dense-control case must exercise a genuinely scrolling inspector");
    await page.locator(".research-inspector").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await capture("dense-inspector-bottom");
    await page.locator(".research-inspector").evaluate((element) => { element.scrollTop = 0; });
  });
  await step("compact-settings-and-guide", async () => {
    await settings(); await audit("compact-settings"); await capture("compact-settings");
    await page.getByRole("tab", { name: "User guide", exact: true }).click();
    await page.getByRole("button", { name: "Open user guide", exact: true }).click();
    await page.getByRole("dialog", { name: "User manual", exact: true }).waitFor();
    await audit("compact-guide"); await capture("compact-guide");
    await page.keyboard.press("Escape");
  });
  await resize(sizes[0]);
  let savedBindings;
  await step("native-save-study", async () => {
    const before = await page.evaluate(() => window.lociResearch.getSnapshot());
    savedBindings = sourceBindings(before);
    const command = await nativeFile("Save study…", "save", "Save research study as");
    await page.waitForFunction(async () => (await window.lociResearch.sessionState())?.storage === "saved");
    const database = path.join(studyPath, "study.sqlite3");
    await fs.access(database);
    const after = await page.evaluate(() => window.lociResearch.getSnapshot());
    assertFixtureBindings(after, savedBindings);
    assert.deepEqual(sourceBindings(after), savedBindings, "Saving must retain exact source IDs, fingerprints and order");
    nativeFileCoverage.push({ ...command, source_bindings: sourceBindings(after),
      saved_database: { file: path.relative(runRoot, database), sha256: await sha256(database) },
      session: await page.evaluate(() => window.lociResearch.sessionState()) });
  });
  await step("native-open-saved-study", async () => {
    // Leave the saved study through its actual UI so Open study must restore
    // persisted bindings, rather than merely observe the already-open study.
    const menu = page.locator("details.workbench-file-menu");
    await menu.locator(":scope > summary").click();
    await menu.getByRole("button", { name: "Recent work", exact: true }).click();
    await page.locator("main.image-first-empty").waitFor();
    await page.waitForFunction(async () => (await window.lociResearch.getSnapshot()) === null);
    const command = await nativeFile("Open study…", "open", "Open research study");
    const reopened = await page.evaluate(() => window.lociResearch.getSnapshot());
    assertFixtureBindings(reopened, savedBindings);
    assert.deepEqual(sourceBindings(reopened), savedBindings, "Saved-study reopen must restore exact source bindings and order");
    assert.equal((await page.evaluate(() => window.lociResearch.sessionState())).storage, "saved");
    nativeFileCoverage.push({ ...command, left_saved_study_before_reopen: true,
      source_bindings: sourceBindings(reopened), session: await page.evaluate(() => window.lociResearch.sessionState()) });
  });
  await step("native-open-folder-research-route", async () => {
    const before = await page.evaluate(() => window.lociResearch.getSnapshot());
    const command = await nativeFile("Open folder…", "open", "Select a folder of research images");
    const after = await page.evaluate(() => window.lociResearch.getSnapshot());
    assertFixtureBindings(after, sourceBindings(before));
    assert.ok(after.sources.length >= before.sources.length && after.sources.length <= before.sources.length + 1,
      "The single-fixture folder may retain or append one source according to the engine duplicate policy");
    assert.equal(await sha256(fixturePath), fixtureIdentity.sha256, "Folder import must preserve fixture bytes");
    nativeFileCoverage.push({ ...command, before_source_count: before.sources.length, after_source_count: after.sources.length,
      source_bindings: sourceBindings(after), matching_fixture_count: after.sources.length });
  });
  await step("native-detached-open-images", async () => {
    const before = await page.evaluate(() => window.lociResearch.getSnapshot());
    const dialogsBefore = await app.evaluate(() => globalThis.__lociDesignQaDialogs.length);
    const { image, entry } = await detachFixture("native-file-detached");
    await (await app.browserWindow(image)).evaluate((window) => { window.show(); window.focus(); });
    await nativeMenu("Window", "Focus control panel");
    await page.waitForFunction(() => document.hasFocus());
    assert.equal(await (await app.browserWindow(page)).evaluate((window) => window.isFocused()), true,
      "Window Focus control panel must focus the real control window");
    const closed = image.waitForEvent("close", { timeout: 30_000 });
    await nativeMenu("File", "Open images…");
    await closed;
    await page.waitForFunction(() => document.querySelector("main.research-workbench") !== null);
    // A duplicate import may leave the count unchanged; observe the picker and
    // completion state rather than assuming that reopening allocates an ID.
    const deadline = Date.now() + 30_000;
    let dialogs;
    while (Date.now() < deadline) {
      dialogs = await app.evaluate(() => globalThis.__lociDesignQaDialogs);
      if (dialogs.length > dialogsBefore) break;
      await page.waitForTimeout(100);
    }
    assert.deepEqual(dialogs.slice(dialogsBefore).map((call) => call.title), ["Add microscopy or medical images"],
      "Detached native Open images must use the research picker, never a legacy picker");
    await page.waitForFunction(() => document.querySelector('.workbench-status [role="status"]')?.textContent === "Local");
    await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60_000 });
    assert.equal((await imageWindowState()).views.length, 0);
    const after = await page.evaluate(() => window.lociResearch.getSnapshot());
    assert.ok(after.sources.some((source) => source.id === entry.target.sourceId && source.sha256 === fixtureIdentity.sha256),
      "Native opening must retain the detached source identity");
    assert.ok(after.sources.every((source) => source.sha256 === fixtureIdentity.sha256),
      "Only the generated fixture may enter this study");
    assert.ok(after.sources.length >= before.sources.length && after.sources.length <= before.sources.length + 1,
      "One picker selection may retain or append one source, according to the engine duplicate policy");
    detachedCoverage.push({ command: "File/Open images", detached_source: entry.target,
      before_source_count: before.sources.length, after_source_count: after.sources.length,
      matching_fixture_count: after.sources.filter((source) => source.sha256 === fixtureIdentity.sha256).length,
      final_source_bindings: after.sources.map(({ id, sha256 }) => ({ id, sha256 })), child_closed: image.isClosed() });
  });
  await step("native-detached-return-to-workspace", async () => {
    const { image, entry } = await detachFixture("native-window-detached");
    await (await app.browserWindow(image)).evaluate((window) => { window.show(); window.focus(); });
    const closed = image.waitForEvent("close", { timeout: 30_000 });
    await nativeMenu("Window", "Return to workspace");
    await closed;
    await assertReturnedImage(entry.target.sourceId);
    const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    assert.ok(snapshot.sources.some((source) => source.id === entry.target.sourceId && source.sha256 === fixtureIdentity.sha256));
    detachedCoverage.push({ command: "Window/Return to workspace", detached_source: entry.target,
      restored_active_source_id: await page.locator(".image-viewport").getAttribute("data-viewer-source"),
      child_closed: image.isClosed(), final_view_count: (await imageWindowState()).views.length });
  });

  assert.deepEqual(await identifyBuild(), buildIdentity, "Tested application identity changed during the journey");
  assert.equal(await sha256(fixturePath), fixtureIdentity.sha256, "Synthetic fixture bytes changed");
  const finalSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(finalSnapshot.results.length, 0, "Design qualification must not run or fabricate scientific results");
  assert.deepEqual(nativeFileCoverage.map((item) => item.command).sort(),
    ["File/Open folder", "File/Open images", "File/Open study", "File/Save study"].sort(), "Cover every native research File command");
  const nativeDialogs = await app.evaluate(() => globalThis.__lociDesignQaDialogs);
  const receipt = { schema: "loci.workbench-design-packaged-qa/v1", status: "passed", started_at: startedAt,
    completed_at: new Date().toISOString(), source: sourceIdentity, build: buildIdentity, fixture: fixtureIdentity,
    matrix: { sizes, resize_observations: resizeCoverage, themes, text_sizes: ["standard", "large"], cases: 42, compact_size: { width: 1100, height: 720 },
      dense_case: "Fluorescence & field assay inspector; no density setting exists" },
    steps, disclosure_coverage: disclosureCoverage, tool_coverage: toolCoverage, native_file_commands: nativeFileCoverage,
    detached_native_commands: detachedCoverage, token_contrast: tokenContrast, geometry, screenshots: captures, renderer, native_dialogs: nativeDialogs,
    limitations: ["Presentation and interaction regression only; no biological or clinical validation.",
      "Native windows constrained by the connected monitor use an explicitly recorded CDP renderer viewport to simulate larger monitors.",
      "Disabled scientific tools retain prerequisite checks; this journey does not manufacture results to enable them.",
      "Detached native command lifecycle is exercised here; scientific image-window interactions remain covered by existing journeys."] };
  await closeApp();
  const receiptPath = path.join(runRoot, "workbench-design-receipt.json");
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(receiptPath + "\n");
} catch (error) {
  const failureScreenshot = page ? await capture("99-failure", false).catch(() => null) : null;
  let closeError;
  try { await closeApp(); } catch (caught) { closeError = String(caught); }
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, "workbench-design-failure.json"), JSON.stringify({
    schema: "loci.workbench-design-packaged-qa-failure/v1", status: "failed", started_at: startedAt,
    failed_at: new Date().toISOString(), step: activeStep, error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined, close_error: closeError, source: sourceIdentity,
    build: buildIdentity, fixture: fixtureIdentity, token_contrast: tokenContrast, native_file_commands: nativeFileCoverage,
    detached_native_commands: detachedCoverage, disclosure_coverage: disclosureCoverage, resize_observations: resizeCoverage, steps, geometry, screenshots: captures,
    failure_screenshot: failureScreenshot, renderer,
  }, null, 2) + "\n");
  throw error;
}
