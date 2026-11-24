/** Packaged macOS arm64 QA journey for Loci's detachable 2D Display inspector.
 * Uses real native Electron windows/controls, isolated --user-data-dir profiles,
 * and native dialog substitution only.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, promisify } from "node:util";

import { placeQaWindow } from "../../scripts/qa/display-placement.mjs";
import { checkPointerGesture, pointerDispatch } from "./detached-pointer-qa-helpers.mjs";
import { closeWithConfirmedQuit, researchSourceButtonSelector } from "./public-hardening-qa-helpers.mjs";
import { selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const exec = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const kidneySha = "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564";
const dragSecondarySha = "7061f0c58d431f0bd7647c38d495a4c1baa066fa9c0d85845b41c7c82c7b939e";
const childTitle = "Loci · Display";
const navigatorTitle = "Loci · Images";
const targetZ = 11; // displayed 12 / 16
const targetZText = "12 / 16";

const args = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: false,
  options: {
    app: { type: "string" }, out: { type: "string" }, source: { type: "string" },
    sha256: { type: "string" }, "source-commit": { type: "string" },
    "secondary-source": { type: "string" }, "secondary-sha256": { type: "string" },
    display: { type: "string" }, input: { type: "string", default: "button" },
    "drag-image": { type: "boolean" }, "drag-agent": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
}).values;

if (args.help) {
  console.log("Usage: node desktop/tests/detached-display-inspector.qa.mjs --app /abs/Loci.app --out /abs/evidence --source /abs/kidney.ome.tiff [--source-commit SHA] [--secondary-source /abs/second.ome.tif --secondary-sha256 SHA] [--display NAME_OR_ID] [--input button|drag] [--drag-image] [--drag-agent]");
  console.log("Drag requires --source-commit. Add pinned secondary input to exercise simultaneous Images and Display. Drag uses app-scoped Chromium input and does not move the OS cursor.");
  process.exit(0);
}

assert.equal(process.platform, "darwin", "Requires macOS.");
assert.equal(process.arch, "arm64", "Requires Apple silicon (arm64).");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, `Requires Node 24+ (found ${process.versions.node}).`);

const appInput = args.app ?? process.env.LOCI_PACKAGED_APP;
const outInput = args.out ?? process.env.LOCI_QA_OUTPUT_ROOT;
const sourceInput = args.source ?? process.env.LOCI_QA_BIO_IMAGE;
const sourceSha = (args.sha256 ?? process.env.LOCI_QA_BIO_IMAGE_SHA256 ?? kidneySha).toLowerCase();
const expectedCommit = args["source-commit"] ?? process.env.LOCI_QA_SOURCE_COMMIT ?? null;
const secondaryInput = args["secondary-source"] ?? process.env.LOCI_QA_SECONDARY_SOURCE ?? null;
const secondarySha = (args["secondary-sha256"] ?? process.env.LOCI_QA_SECONDARY_SOURCE_SHA256 ?? "").toLowerCase() || null;
const display = args.display ?? process.env.LOCI_QA_SECONDARY_DISPLAY ?? undefined;

assert.ok(appInput && path.isAbsolute(appInput), "Pass --app or LOCI_PACKAGED_APP as an absolute path.");
assert.ok(outInput && path.isAbsolute(outInput), "Pass --out or LOCI_QA_OUTPUT_ROOT as an absolute path.");
const relOut = path.relative(repo, outInput);
assert.ok(relOut.startsWith(`..${path.sep}`) || relOut === ".." || relOut === ".loci" || relOut.startsWith(`.loci${path.sep}`),
  "Keep QA evidence outside Git or under ignored .loci/.");
assert.ok(sourceInput && path.isAbsolute(sourceInput), "Pass --source or LOCI_QA_BIO_IMAGE as an absolute path.");
assert.equal(sourceSha, kidneySha, `Pin the public CC0 kidney SHA-256 (${kidneySha}).`);
if (expectedCommit) assert.match(expectedCommit, /^[0-9a-f]{40}$/u, "Invalid --source-commit.");
if (secondaryInput || secondarySha) {
  assert.ok(secondaryInput && path.isAbsolute(secondaryInput), "Secondary source must be an absolute path.");
  assert.match(secondarySha ?? "", /^[0-9a-f]{64}$/u, "Secondary source requires an exact 64-char SHA-256 pin.");
}

assert.ok(["button", "drag"].includes(args.input), "--input must be button or drag.");
const drag = args.input === "drag";
assert.ok(!drag || expectedCommit, "--input=drag requires the exact candidate --source-commit.");
if (drag && secondaryInput) assert.equal(secondarySha, dragSecondarySha, "Pin the approved CellSeg3D secondary fixture for the drag journey.");
assert.ok(drag || !(args["drag-image"] || args["drag-agent"]), "--drag-image and --drag-agent require --input=drag.");

const bundle = await fs.realpath(appInput);
const kidneyFile = await fs.realpath(sourceInput);
const secondaryFile = secondaryInput ? await fs.realpath(secondaryInput) : null;
await fs.mkdir(outInput, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(await fs.realpath(outInput), drag ? "detached-pointer-" : "detached-display-"));
await fs.chmod(runRoot, 0o700);
const studyPath = path.join(runRoot, "detached-display.loci-study");
const reportPath = path.join(runRoot, "report.json");
const artifacts = {
  executable: path.join(bundle, "Contents/MacOS/Loci"),
  asar: path.join(bundle, "Contents/Resources/app.asar"),
  worker: path.join(bundle, "Contents/Resources/loci-engine/loci-engine"),
  identity: path.join(bundle, "Contents/Resources/loci-build-identity.json"),
};

const sha256 = async (file) => {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest("hex");
};
const statPlain = async (file, label) => {
  const s = await fs.lstat(file);
  assert.ok(s.isFile() && !s.isSymbolicLink(), `${label} must be a plain file.`);
  return { size: s.size, mtimeMs: s.mtimeMs, sha256: await sha256(file) };
};
const redact = (v) => String(v).replaceAll(kidneyFile, "<public-kidney>").replaceAll(secondaryFile ?? "\0", "<secondary-source>")
  .replaceAll(bundle, "<app-bundle>").replaceAll(runRoot, "<qa-run>").replaceAll(repo, "<repo>");

const report = {
  schema: "loci.packaged-detached-display-qa/v1", status: "running", stage: "preflight",
  started_at: new Date().toISOString(), node_version: process.versions.node,
  child_title: childTitle, expected_source_revision: expectedCommit,
  fixtures: { kidney: { filename: path.basename(kidneyFile), expected_sha256: kidneySha } },
  passed: [], screenshots: [], canvas: {}, layout: {}, focus: {}, persisted: {},
  renderer_errors: [], console_errors: [], blocked_requests: [],
  not_exercised: [
    "raw 3D docked instrument", "physical monitor hot-unplug", "biological/clinical validation", "non-macOS platforms",
    ...(!secondaryFile ? ["optional second-source stale-binding check (pass --secondary-source and --secondary-sha256)"] : []),
  ],
};
if (drag) {
  report.pointer_input = { ...pointerDispatch, cases: [] };
  report.not_exercised.push("physical hardware mouse and macOS event routing outside Loci's Chromium target");
  if (!secondaryFile) report.not_exercised.push("simultaneous detached Images and Display across a second source");
  if (!args["drag-image"]) report.not_exercised.push("image toolbar drag (opt in with --drag-image)");
  if (!args["drag-agent"]) report.not_exercised.push("Agent drawer drag (opt in with --drag-agent)");
}
const saveReport = () => fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function poll(check, label, timeoutMs = 45_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const val = await check();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function sampleCanvas(page, sourceId, requireSignal = true) {
  const viewer = page.locator(`.image-viewport[data-viewer-source="${sourceId}"][data-prepared="true"]`);
  await viewer.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction((id) => {
    const c = document.querySelector(`.image-viewport[data-viewer-source="${id}"][data-prepared="true"] > canvas`);
    if (!c?.width || !c.height) return false;
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && Math.abs(c.width - Math.round(r.width * devicePixelRatio)) <= 1 && Math.abs(c.height - Math.round(r.height * devicePixelRatio)) <= 1;
  }, sourceId, { timeout: 60_000 });
  await raf2(page);
  const s = await viewer.evaluate(async (el) => {
    const c = el.querySelector("canvas"), r = c.getBoundingClientRect();
    const full = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const probe = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(c, 0, 0, 64, 64);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    let lit = 0, colored = 0;
    for (let i = 0; i < px.length; i += 4) {
      const hi = Math.max(px[i], px[i + 1], px[i + 2]), lo = Math.min(px[i], px[i + 1], px[i + 2]);
      if (hi >= 12) lit++;
      if (hi - lo >= 6) colored++;
    }
    const digest = await crypto.subtle.digest("SHA-256", full);
    const hex = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
    return { camera: JSON.parse(el.dataset.camera), width: Math.round(r.width), height: Math.round(r.height), lit_samples: lit, colored_samples: colored, rgba_sha256: hex, probe: Array.from(px) };
  });
  if (requireSignal) assert.ok(s.width >= 100 && s.height >= 100 && s.lit_samples > 50, `Weak canvas signal (${s.lit_samples}).`);
  return s;
}

function diffCanvas(before, after, label, minFrac = 0.002, minDelta = 0.25) {
  let changed = 0, sum = 0;
  for (let i = 0; i < before.probe.length; i += 4) {
    const dr = Math.abs(after.probe[i] - before.probe[i]), dg = Math.abs(after.probe[i + 1] - before.probe[i + 1]), db = Math.abs(after.probe[i + 2] - before.probe[i + 2]);
    if (dr || dg || db) changed++;
    sum += (dr + dg + db) / 3;
  }
  const n = before.probe.length / 4, frac = changed / n, mean = sum / n;
  assert.notEqual(after.rgba_sha256, before.rgba_sha256, `${label}: RGBA hash unchanged.`);
  assert.ok(frac >= minFrac && mean >= minDelta, `${label}: delta too small (frac=${frac.toFixed(5)}, mean=${mean.toFixed(3)}).`);
  return { changed_fraction: Number(frac.toFixed(5)), mean_abs_delta: Number(mean.toFixed(3)) };
}

async function waitForDistinctCanvas(page, sourceId, prev, label, minFrac = 0.002, minDelta = 0.25) {
  const deadline = performance.now() + 20_000;
  let cur = null;
  while (performance.now() < deadline) {
    cur = await sampleCanvas(page, sourceId);
    try { return { sample: cur, delta: diffCanvas(prev, cur, label, minFrac, minDelta) }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  cur ??= await sampleCanvas(page, sourceId);
  return { sample: cur, delta: diffCanvas(prev, cur, label, minFrac, minDelta) };
}

const stripProbe = ({ probe: _p, ...rest }) => rest;
const getView = (page, id) => page.evaluate((source_id) => window.lociResearch.execute("source_view", { source_id }), id);
const zOut = (scope) => scope.locator('.source-axes label:has(input[aria-label="Z plane"]) output');
async function openChannel(scope, n) {
  const row = scope.locator(`details.source-channel:has(input[aria-label="Channel ${n} visible"])`);
  await row.waitFor({ state: "visible" });
  if (!(await row.evaluate((el) => el.open))) await row.locator(":scope > summary").click();
}
async function setRange(scope, name, target, increment, readOutput) {
  const slider = scope.getByRole("slider", { name, exact: true });
  await slider.waitFor({ state: "visible" });
  let position = Number(await slider.inputValue());
  if (target < position / 2) {
    await slider.press("Home");
    await poll(async () => (await readOutput()) === 0, name + " at minimum");
    position = 0;
  }
  const steps = Math.round((target - position) / increment);
  for (let n = 1; n <= Math.abs(steps); n++) {
    const expected = Number((position + Math.sign(steps) * n * increment).toFixed(2));
    await slider.press(steps > 0 ? "ArrowRight" : "ArrowLeft");
    // Each displayed value comes back from the authoritative workbench.
    await poll(async () => (await readOutput()) === expected, name + " at " + expected);
  }
  assert.equal(Number(await slider.inputValue()), target);
}
async function setZ(scope, z, expectedText) {
  const output = zOut(scope);
  await setRange(scope, "Z plane", z, 1, async () => Number((await output.textContent()).split("/")[0].trim()) - 1);
  assert.equal((await output.textContent()).trim(), expectedText);
}
async function setFirstOpacity(scope, value) {
  const output = scope.getByLabel("Channel 1 opacity value", { exact: true });
  await setRange(scope, "Channel 1 opacity", value, 0.01, async () => Number(await output.textContent()));
}
async function assertKidneyPanel(scope, opacityText) {
  assert.equal(await scope.getByRole("slider", { name: "Z plane", exact: true }).inputValue(), String(targetZ));
  assert.equal((await zOut(scope).textContent())?.trim(), targetZText);
  await openChannel(scope, 1);
  assert.equal((await scope.getByLabel("Channel 1 opacity value", { exact: true }).textContent())?.trim(), opacityText);
  assert.equal(await scope.getByRole("checkbox", { name: "Channel 1 visible", exact: true }).isChecked(), true);
  assert.equal(await scope.getByRole("checkbox", { name: "Channel 2 visible", exact: true }).isChecked(), false);
}
function assertView(rec, { id, sha, z, minRev = 1, exactRev, ch0Opacity, ch1Visible, count }, label) {
  assert.equal(rec?.source_id, id, `${label}: source_id`);
  assert.equal(rec?.source_sha256, sha, `${label}: source_sha256`);
  if (exactRev !== undefined) assert.equal(rec.revision, exactRev, `${label}: revision changed`);
  else assert.ok(rec.revision >= minRev, `${label}: revision < ${minRev}`);
  assert.equal(rec.state?.projection, "plane", `${label}: projection`);
  assert.equal(rec.state?.selection?.z, z, `${label}: zero-based z`);
  if (count !== undefined) assert.equal(rec.state?.channels?.length, count, `${label}: channel count`);
  const ch0 = rec.state.channels.find((c) => c.channel === 0);
  assert.ok(ch0?.visible === true && Math.abs((ch0.opacity ?? 1) - ch0Opacity) <= 1e-6, `${label}: ch0`);
  if (ch1Visible !== undefined) assert.equal(rec.state.channels.find((c) => c.channel === 1)?.visible, ch1Visible, `${label}: ch1`);
  return { source_id: rec.source_id, source_sha256: rec.source_sha256, revision: rec.revision, z: rec.state.selection.z, channels: rec.state.channels };
}
function readSqliteDisplay(studyDir, sourceId) {
  const db = new DatabaseSync(path.join(studyDir, "study.sqlite3"), { readOnly: true });
  try {
    const row = db.prepare("SELECT record FROM documents WHERE kind = 'display' AND id = ?").get(sourceId);
    assert.ok(row?.record, `Missing SQLite display record for ${sourceId}`);
    const env = JSON.parse(row.record);
    assert.equal(env.data?.schema, "loci.source-view/v1");
    return { source_id: env.data.source_id, source_sha256: env.data.source_sha256, revision: env.revision, state: env.data.state };
  } finally { db.close(); }
}

async function checkLayout(page, label) {
  await raf2(page);
  const panel = page.locator(".display-inspector-body");
  const controls = ["Z plane", "Channel 1 visible", "Channel 1 opacity", "Channel 2 visible", "Dock Display"];
  for (const name of controls) {
    const control = name === "Dock Display" ? page.getByRole("button", { name, exact: true }) : page.getByLabel(name, { exact: true });
    await control.scrollIntoViewIfNeeded();
    const reachable = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1 && (hit === el || el.contains(hit));
    });
    assert.ok(reachable, label + ": unreachable control " + name);
  }
  await panel.evaluate((el) => el.scrollTo(0, 0));
  await raf2(page);
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(geometry.scrollWidth <= geometry.width + 1, label + ": horizontal overflow");
  const zText = (await zOut(page).textContent()).trim();
  assert.equal(zText, targetZText);
  return { ...geometry, zText, controls: controls.length };
}

async function expectFocusOnDetach(mainPage, label, name = "Detach Display") {
  const btn = button(mainPage, name);
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  try {
    await btn.and(mainPage.locator(":focus")).waitFor({ timeout: 5_000 });
    return { returned_to: name, verified: true };
  } catch (error) {
    const info = await mainPage.evaluate(() => ({ hasFocus: document.hasFocus(), active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? null }));
    throw new Error(`${label}: focus did not return to ${name} (${JSON.stringify(info)})`, { cause: error });
  }
}

async function waitForDisplayChild(app, mainPage) {
  const child = await poll(async () => {
    for (const p of app.windows()) {
      if (p === mainPage || p.isClosed()) continue;
      if (await p.locator("main.display-inspector-window").count().catch(() => 0)) return p;
    }
    return null;
  }, `child window "${childTitle}"`);
  const native = await app.browserWindow(child);
  assert.equal(await native.evaluate((win) => win.getTitle()), childTitle, "Native Display window title");
  await native.dispose();
  assert.equal(await child.title(), childTitle, "Display document title");
  return child;
}

let app = null, main = null, child = null, failure = null, kidneyBefore = null, secondaryBefore = null;
const button = (page, name) => page.getByRole("button", { name, exact: true });
const pointer = (locator, label, options = {}) => checkPointerGesture({ app, main, locator, label, cases: report.pointer_input.cases, poll, ...options });
const dragPanel = (name, title, side = "right") => pointer(button(main, name), name, { title, side });

async function closeToDock(page, name, total = 1) {
  await button(page, name).click();
  await poll(() => page.isClosed() && app.windows().length === total, `${name} closes the native child`);
}

async function checkDockedGestures(sourceId, mainDisplay, initialZ) {
  const handle = button(main, "Detach Display");
  await pointer(handle, "outside and back inside", { outcome: "reenter", side: "right" });
  await pointer(handle, "Escape while outside", { outcome: "escape", side: "left" });
  const canvas = main.locator(`.image-viewport[data-viewer-source="${sourceId}"][data-prepared="true"] > canvas`);
  await pointer(canvas, "unrelated canvas pan", { outcome: "unrelated", side: "right" });
  await button(main, "Fit image").click();
  await pointer(mainDisplay.getByRole("slider", { name: "Z plane", exact: true }), "unrelated Z slider drag", { outcome: "unrelated", side: "left" });
  await setZ(mainDisplay, initialZ, `${initialZ + 1} / 16`);
  await mainDisplay.waitFor();
  report.passed.push("outside-and-back, Escape, canvas and slider drags left Display docked");
}

const navigatorRegion = (page, name) => page.getByRole("region", { name, exact: true });
const sourceRow = (list, id) => list.locator(`button[data-source-id="${id}"]`);
const navigatorState = (page) => page.evaluate(() => window.lociStudyNavigator.state());
const displayBinding = (page) => page.evaluate(async () => (await window.lociDisplayInspector.state()).binding);
const mainCanvas = (id) => main.locator(`.image-viewport[data-viewer-source="${id}"] > canvas`);
const isMainCanvas = (handle, id) => handle.evaluate((canvas, sourceId) =>
  canvas === document.querySelector(`.image-viewport[data-viewer-source="${sourceId}"] > canvas`), id);
const displayValues = ({ source_id, source_sha256, state: { camera: _camera, ...view } }) => ({ source_id, source_sha256, view });

async function navigatorLayout(page, width) {
  const { workArea } = report.display_placements.at(-1).selected_display;
  const native = await app.browserWindow(page);
  const bounds = { x: workArea.x + 20, y: workArea.y + 20, width, height: Math.min(640, workArea.height - 40) };
  try {
    await native.evaluate((window, value) => window.setBounds(value), bounds);
    await poll(() => page.evaluate((value) => Math.abs(innerWidth - value) <= 1, width), `Images ${width}px viewport`);
    await raf2(page);
    const actual = await native.evaluate(window => window.getBounds());
    assert.equal(actual.width, width, "native Images width");
    const layout = await page.evaluate(() => {
      const zone = (selector) => {
        const node = document.querySelector(selector), rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          scroll_width: node.scrollWidth, client_width: node.clientWidth };
      };
      return { width: innerWidth, scroll_width: document.documentElement.scrollWidth,
        list: zone(".study-navigator-tree-pane"), details: zone(".study-navigator-details"),
        compact: getComputedStyle(document.querySelector(".study-navigator-compact-meta")).display !== "none",
        full: getComputedStyle(document.querySelector(".study-navigator-meta-list")).display !== "none" };
    });
    assert.ok(layout.scroll_width <= layout.width + 1, "Images document overflows horizontally");
    for (const pane of [layout.list, layout.details]) {
      assert.ok(pane.client_width > 0 && pane.scroll_width <= pane.client_width + 1, "Images pane overflows horizontally");
      assert.ok(pane.left >= -1 && pane.right <= layout.width + 1 && pane.bottom > pane.top, "Images pane is clipped");
    }
    const wide = width >= 600;
    assert.equal(layout.compact, !wide);
    assert.equal(layout.full, wide);
    assert.ok(wide ? layout.list.right <= layout.details.left + 1 : layout.details.bottom <= layout.list.top + 1,
      "Images list and details do not occupy the expected split or stacked layout");
    return { native_width: actual.width, ...layout };
  } finally { await native.dispose(); }
}

async function verifyNavigatorSource(page, source) {
  const state = await poll(async () => {
    const value = await navigatorState(page);
    return value.snapshot.activeSourceId === source.id && value.snapshot.activeSourceSha256 === source.sha256 ? value : null;
  }, `Images active source ${source.id} with exact fingerprint`);
  const row = sourceRow(navigatorRegion(page, "Study image list"), source.id);
  await poll(async () => (await row.getAttribute("aria-current")) === "true", "Images current row");
  assert.equal((await navigatorRegion(page, "Active image details").locator(".study-navigator-active-name").textContent()).trim(), source.name);
  return { source_id: source.id, source_sha256: source.sha256, binding: state.binding, sequence: state.sequence };
}

async function keyOpenImage(page, from, to) {
  const tree = page.getByRole("tree", { name: "Study images", exact: true });
  const rows = await tree.getByRole("treeitem").evaluateAll(nodes => nodes.map(node => node.dataset.sourceId ?? null));
  const start = rows.indexOf(from.id), end = rows.indexOf(to.id);
  assert.ok(start >= 0 && end >= 0 && start !== end, "Both exact sources must be present for keyboard navigation");
  await sourceRow(tree, from.id).focus();
  const direction = end > start ? "ArrowDown" : "ArrowUp";
  for (let index = 0; index < Math.abs(end - start); index++) await page.keyboard.press(direction);
  await sourceRow(tree, to.id).and(page.locator(":focus")).waitFor();
  assert.equal(await sourceRow(tree, from.id).getAttribute("aria-current"), "true", "Arrow keys move focus without opening an image");
  await page.keyboard.press("Enter");
  return { direction, steps: Math.abs(end - start), from: from.id, to: to.id };
}

async function checkImagesWithDisplay(kidney, secondary) {
  report.stage = "drag-images-and-display";
  const evidence = report.pointer_input.navigator = { layout: {}, navigation: [], lifecycle: {} };
  await selectWorkbenchTool(main, "Display");
  let displayPanel = await dragPanel("Detach Display", childTitle, "right");
  await displayPanel.locator(".source-display").waitFor();
  await assertKidneyPanel(displayPanel, "0.42");
  const originalCanvas = await mainCanvas(kidney.id).elementHandle();
  assert.ok(originalCanvas, "Kidney canvas is mounted before detaching Images");
  const header = main.locator(".research-sources-header");
  const grip = header.getByRole("heading", { name: /^Images\b/u });
  await pointer(header, "Images header returns inside before release", { grip, outcome: "reenter", side: "left" });
  const images = await pointer(header, "Images header outside release", { grip, title: navigatorTitle, side: "left" });
  await images.getByRole("main", { name: "Images navigator", exact: true }).waitFor();
  assert.equal(await images.title(), navigatorTitle);
  assert.equal(app.windows().length, 3, "Images and Display coexist with one main viewport");
  await button(main, "Focus Images navigator").press("Enter");
  assert.ok(await isMainCanvas(originalCanvas, kidney.id), "Detaching Images replaced the live kidney canvas");
  await originalCanvas.dispose();
  evidence.viewport_on_detach = stripProbe(await sampleCanvas(main, kidney.id));
  const concurrentDisplay = await displayBinding(displayPanel);
  assert.deepEqual([concurrentDisplay.sourceId, concurrentDisplay.sourceSha256], [kidney.id, kidney.sha256]);
  evidence.concurrent_display = concurrentDisplay;

  evidence.restricted_bridge = await images.evaluate(() => ({
    methods: Object.keys(window.lociStudyNavigator).sort(),
    other_capabilities: ["lociStudyNavigatorOwner", "lociResearch", "lociDisplayInspector", "lociDisplayInspectorOwner", "lociImageWindows", "require"]
      .filter(name => typeof window[name] !== "undefined"),
  }));
  assert.deepEqual(evidence.restricted_bridge, { methods: ["act", "dock", "onState", "state"], other_capabilities: [] });
  const initial = await verifyNavigatorSource(images, kidney);
  const inventory = (await navigatorState(images)).snapshot.sources.map(({ id, sha256 }) => [id, sha256]).sort();
  assert.deepEqual(inventory, [kidney, secondary].map(({ id, sha256 }) => [id, sha256]).sort());
  evidence.native_and_document_title = navigatorTitle;
  evidence.sources = inventory;

  const list = navigatorRegion(images, "Study image list");
  const search = list.getByRole("searchbox", { name: "Search images and folders", exact: true });
  evidence.layout.narrow = await navigatorLayout(images, 320);
  await button(images, "Dock Images").focus();
  await images.keyboard.press("Tab");
  await search.and(images.locator(":focus")).waitFor();
  await search.fill(secondary.name);
  await sourceRow(list, secondary.id).waitFor();
  await sourceRow(list, kidney.id).waitFor({ state: "hidden" });
  await button(list, "Clear image search").press("Enter");
  await button(list, "Folder tree").press("Enter");
  evidence.layout.narrow.keyboard_search = true;
  await capture(images, "13a-images-narrow", "320px Images navigator with compact active details beside detached Display");

  const kidneyPixels = await sampleCanvas(main, kidney.id);
  const kidneyBefore = await getView(main, kidney.id);
  const secondaryBefore = displayValues(await getView(main, secondary.id));
  const toSecondary = await keyOpenImage(images, kidney, secondary);
  const activeSecondary = await verifyNavigatorSource(images, secondary);
  assert.deepEqual(activeSecondary.binding, initial.binding, "Images stayed in the same study session across source switch");
  assert.ok(activeSecondary.sequence > initial.sequence);
  const secondaryPixels = await sampleCanvas(main, secondary.id, false);
  evidence.navigation.push({ ...toSecondary, active: activeSecondary, canvas: stripProbe(secondaryPixels),
    delta: diffCanvas(kidneyPixels, secondaryPixels, "navigator opened distinct secondary image pixels") });
  assert.deepEqual(await getView(main, kidney.id), kidneyBefore, "Images switch must preserve the kidney display record");
  const displayTransition = await poll(async () => {
    if (displayPanel.isClosed()) return "auto-docked";
    const binding = await displayBinding(displayPanel).catch(() => null);
    return binding?.sourceId === secondary.id && binding.sourceSha256 === secondary.sha256 ? "rebound" : null;
  }, "Display cleanly docks or rebinds on navigator source switch");
  report.pointer_input.navigator_source_switch = { from: kidney.sha256, to: secondary.sha256, display: displayTransition };

  evidence.layout.wide = await navigatorLayout(images, 640);
  const fingerprint = navigatorRegion(images, "Active image details").locator(`dd[title="${secondary.sha256}"]`);
  await fingerprint.waitFor({ state: "visible" });
  assert.equal((await fingerprint.textContent()).trim(), secondary.sha256.slice(0, 12));
  await capture(images, "13b-images-wide", "640px Images navigator with split image list and CellSeg3D details");
  const toKidney = await keyOpenImage(images, secondary, kidney);
  const activeKidney = await verifyNavigatorSource(images, kidney);
  assert.deepEqual(activeKidney.binding, initial.binding);
  assert.ok(activeKidney.sequence > activeSecondary.sequence);
  const returnedPixels = await sampleCanvas(main, kidney.id);
  evidence.navigation.push({ ...toKidney, active: activeKidney, canvas: stripProbe(returnedPixels),
    delta: diffCanvas(secondaryPixels, returnedPixels, "navigator returned to kidney image pixels") });
  assert.deepEqual(displayValues(await getView(main, secondary.id)), secondaryBefore, "Returning to kidney must preserve secondary display settings");
  assertView(await getView(main, kidney.id), { id: kidney.id, sha: kidney.sha256, z: targetZ, ch0Opacity: 0.42, ch1Visible: false, count: 3 }, "navigator restored kidney view");

  if (displayPanel.isClosed()) {
    await button(main, "Detach Display").click();
    displayPanel = await waitForDisplayChild(app, main);
  }
  await assertKidneyPanel(displayPanel, "0.42");
  const returnedCanvas = await mainCanvas(kidney.id).elementHandle();
  assert.ok(returnedCanvas);
  await button(images, "Dock Images").press("Enter");
  await poll(() => images.isClosed() && app.windows().length === 2, "keyboard Dock Images closes only Images");
  evidence.lifecycle.dock = await expectFocusOnDetach(main, "Dock Images command", "Detach Images");
  await sourceRow(main.locator(".research-sources"), kidney.id).waitFor();
  assert.ok(await isMainCanvas(returnedCanvas, kidney.id), "Docking Images replaced the kidney canvas");

  await button(main, "Detach Images").press("Enter");
  const reopened = await poll(async () => {
    for (const page of app.windows()) if (!page.isClosed() && await page.title().catch(() => null) === navigatorTitle) return page;
    return null;
  }, "keyboard reopens Images");
  assert.equal(app.windows().length, 3);
  const reopenedTarget = await verifyNavigatorSource(reopened, kidney);
  assert.ok(reopenedTarget.binding.generation > initial.binding.generation);
  const native = await app.browserWindow(reopened);
  try { await native.evaluate(window => window.close()); } finally { await native.dispose(); }
  await poll(() => reopened.isClosed() && app.windows().length === 2, "native Images close leaves Display open");
  evidence.lifecycle.native_close = await expectFocusOnDetach(main, "Native Images close", "Detach Images");
  assert.ok(await isMainCanvas(returnedCanvas, kidney.id), "Closing Images replaced the kidney canvas");
  await returnedCanvas.dispose();
  evidence.lifecycle.same_canvas_on_both_closes = true;
  await closeToDock(displayPanel, "Dock Display");
  report.passed.push("Images header drag, responsive keyboard navigation, and both dock routes preserved the source-bound main viewport and Display");
}

async function checkAdditionalDragRoutes(kidney, secondary) {
  report.stage = "drag-preprocess";
  const before = await main.evaluate(() => window.lociResearch.getSnapshot());
  await selectWorkbenchTool(main, "Process");
  const preprocess = await dragPanel("Detach Preprocess", "Loci · Preprocess", "right");
  await preprocess.getByRole("region", { name: "Analysis scope", exact: true }).waitFor();
  await preprocess.getByText(`Image · ${kidney.name}`, { exact: true }).waitFor();
  assert.equal(await preprocess.title(), "Loci · Preprocess", "Preprocess document title");
  const pipeline = preprocess.getByRole("region", { name: "Processing pipeline", exact: true });
  await button(pipeline, "Add processing step").click();
  await button(pipeline, "Subtract constant").click();
  const value = pipeline.getByLabel("Step 1 value", { exact: true });
  await value.fill("123.5");
  await value.press("Enter");
  await capture(preprocess, "12-drag-preprocess", "Detached Preprocess opened by an outside drag; live source and edit");
  await closeToDock(preprocess, "Dock Preprocess");
  const dockedPipeline = main.getByRole("region", { name: "Processing pipeline", exact: true });
  const dockedStep = dockedPipeline.locator(".preprocess-step-toggle").first();
  if (await dockedStep.getAttribute("aria-expanded") !== "true") await dockedStep.click();
  assert.equal(await dockedPipeline.getByLabel("Step 1 value", { exact: true }).inputValue(), "123.5", "retained docked Preprocess edit");
  report.passed.push("outside drag detached Preprocess with the active kidney source; numeric edit was retained on dock");

  if (secondary) await checkImagesWithDisplay(kidney, secondary);

  if (args["drag-image"]) {
    report.stage = "drag-image-toolbar";
    await selectWorkbenchTool(main, "Display");
    const image = await dragPanel("Detach image", `Loci · A · ${kidney.name}`, "right");
    const initial = await sampleCanvas(image, kidney.id);
    await button(image, "Zoom in").click();
    await poll(async () => (await sampleCanvas(image, kidney.id)).camera.scale > initial.camera.scale * 1.05, "zoom in detached kidney image");
    await capture(image, "14-drag-image", "Kidney image opened by its own toolbar drag, retaining live viewport controls");
    await button(main, "Return to workspace").click();
    await poll(() => image.isClosed() && app.windows().length === 1, "image returned to full workspace");
    await sampleCanvas(main, kidney.id);
    report.passed.push("outside drag on the image toolbar transferred the exact kidney view and retained zoom and return controls");
  }

  if (args["drag-agent"]) {
    report.stage = "drag-agent-drawer";
    const trigger = button(main, "Agent session status");
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    const drawer = main.getByRole("region", { name: "Agent session and approvals", exact: true });
    const agent = await pointer(button(drawer, "Pop out"), "Agent Pop out", { title: "Loci · Agent workspace" });
    await agent.getByRole("heading", { name: "Agent workspace", exact: true }).waitFor();
    await capture(agent, "15-drag-agent", "Agent workspace was opened with an outside drag, without configuring a connection");
    await closeToDock(agent, "Return to workspace");
    report.passed.push("outside drag opened and returned the Agent workspace without an external connection");
  }

  const after = await main.evaluate(() => window.lociResearch.getSnapshot());
  assert.deepEqual(after.sources.map(({ id, sha256 }) => [id, sha256]), before.sources.map(({ id, sha256 }) => [id, sha256]));
  assert.deepEqual(after.results.map(({ id, revision_hash }) => [id, revision_hash]), before.results.map(({ id, revision_hash }) => [id, revision_hash]));
}
const watch = (page, tag) => {
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (e) => report.renderer_errors.push({ window: tag, message: redact(e.message) }));
  page.on("console", (m) => { if (m.type() === "error") report.console_errors.push({ window: tag, text: redact(m.text()) }); });
  void page.context().route(/^https?:\/\//u, (route) => {
    report.blocked_requests.push({ window: tag, url: new URL(route.request().url()).protocol });
    return route.abort("blockedbyclient");
  });
};
async function capture(page, name, description) {
  await raf2(page);
  const file = path.join(runRoot, `${name}.png`);
  const bytes = await page.screenshot({ path: file, scale: "css", animations: "allow" });
  await fs.chmod(file, 0o600);
  assert.ok(bytes.length > 1000, `Tiny capture ${name}`);
  report.screenshots.push({ filename: `${name}.png`, description, dimensions: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)], sha256: createHash("sha256").update(bytes).digest("hex") });
}
async function launch(profile, { reopen = false } = {}) {
  const { _electron: electron } = await import("playwright");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launched = await electron.launch({
    executablePath: artifacts.executable, cwd: desktop,
    args: [`--user-data-dir=${path.join(runRoot, `user-data-${profile}`)}`], env, timeout: 120_000,
  });
  const first = await launched.firstWindow();
  watch(first, `${profile}:main`);
  launched.on("window", (w) => { if (w !== first) watch(w, `${profile}:child`); });
  await placeQaWindow(launched, { requestedDisplay: display, launch: profile }, report);
  await launched.evaluate(({ dialog }, opts) => {
    let idx = 0;
    dialog.showOpenDialog = async (...a) => {
      const title = a.at(-1)?.title ?? "";
      if (title === "Add microscopy or medical images" && opts.openFiles[idx]) return { canceled: false, filePaths: [opts.openFiles[idx++]] };
      if (title === "Open research study" && opts.reopen) return { canceled: false, filePaths: [opts.studyPath] };
      throw new Error(`Unexpected open dialog: ${title}`);
    };
    dialog.showSaveDialog = async (...a) => {
      if ((a.at(-1)?.title ?? "") === "Save research study as") return { canceled: false, filePath: opts.studyPath };
      throw new Error(`Unexpected save dialog: ${a.at(-1)?.title}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { openFiles: reopen ? [] : [kidneyFile, ...(secondaryFile ? [secondaryFile] : [])], studyPath, reopen });
  return { launched, first };
}

try {
  // 1. Signed package identity & source preflight.
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle], { timeout: 60_000 });
  report.codesign_verified = true;
  report.identity = JSON.parse(await fs.readFile(artifacts.identity, "utf8"));
  assert.equal(report.identity.sourceDirty, false, "Packaged candidate must be clean.");
  if (expectedCommit) assert.equal(report.identity.sourceRevision, expectedCommit, "Source commit mismatch.");
  report.artifact_sha256 = Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([k, f]) => [k, await sha256(f)])));
  report.harness_sha256 = await sha256(import.meta.filename);
  if (drag) {
    report.pointer_input.helper_sha256 = await sha256(path.join(import.meta.dirname, "detached-pointer-qa-helpers.mjs"));
    const { stdout } = await exec("git", ["-C", repo, "rev-parse", "HEAD", "HEAD^{tree}"]);
    const [commit, tree] = stdout.trim().split("\n");
    report.pointer_input.harness_source = { commit, tree };
  }
  kidneyBefore = await statPlain(kidneyFile, "Public kidney fixture");
  assert.equal(kidneyBefore.sha256, kidneySha);
  report.fixtures.kidney = { ...report.fixtures.kidney, size_bytes: kidneyBefore.size, sha256_before: kidneyBefore.sha256 };
  if (secondaryFile) {
    secondaryBefore = await statPlain(secondaryFile, "Secondary permitted fixture");
    assert.equal(secondaryBefore.sha256, secondarySha);
    report.fixtures.secondary = { filename: path.basename(secondaryFile), size_bytes: secondaryBefore.size, sha256_before: secondaryBefore.sha256 };
  }
  await saveReport();

  // 2. Open kidney as 2D stack; explicitly enable Ch1 + Ch2 (kidney defaults often show Ch1 only).
  report.stage = "open-kidney-2d";
  ({ launched: app, first: main } = await launch("initial"));
  await main.getByRole("button", { name: "Open images", exact: true }).click();
  const snap1 = await waitForSnapshot(main, (s) => s?.sources?.length === 1 && s.sources[0].sha256 === kidneySha, "kidney import", 90_000);
  const kidney = snap1.sources[0];
  assert.deepEqual([kidney.metadata.dimensions?.c, kidney.metadata.dimensions?.z], [3, 16]);
  report.fixtures.kidney.source_id = kidney.id;

  await selectWorkbenchTool(main, "Display");
  await main.locator("fieldset.source-display-local:not([disabled])").waitFor({ state: "visible" });
  await main.getByRole("button", { name: "Fit image", exact: true }).click();
  const mainDisplay = main.locator(".research-inspector .source-display");
  const initialZ = Number(await mainDisplay.getByRole("slider", { name: "Z plane", exact: true }).inputValue());
  assert.notEqual(initialZ, targetZ);
  const defaultVisible = [];
  for (const ch of [1, 2]) {
    const box = mainDisplay.getByRole("checkbox", { name: `Channel ${ch} visible`, exact: true });
    const was = await box.isChecked();
    defaultVisible.push({ channel: ch, initially_checked: was });
    if (!was) await box.check();
    assert.equal(await box.isChecked(), true);
  }
  if (drag) {
    report.stage = "negative-pointer-gestures";
    await checkDockedGestures(kidney.id, mainDisplay, initialZ);
  }
  const baseline = await sampleCanvas(main, kidney.id);
  report.canvas.baseline = { initial_z: initialZ, default_visible: defaultVisible, ...stripProbe(baseline) };
  await capture(main, "01-docked-baseline", "Docked 2D Display baseline with Ch1 & Ch2 visible");
  report.passed.push("opened pinned kidney 2D stack with verified Ch1+Ch2 baseline");

  // 3. Detach Display; prove main canvas stays mounted & usable without entering detached-image mode.
  report.stage = "detach-display";
  await main.evaluate((id) => {
    const vp = document.querySelector(`.image-viewport[data-viewer-source="${id}"]`);
    globalThis.__stageRefs = { vp, canvas: vp?.querySelector("canvas") };
  }, kidney.id);
  if (drag) child = await dragPanel("Detach Display", childTitle, "right");
  else await button(main, "Detach Display").click();
  child = await waitForDisplayChild(app, main);
  await child.locator(".source-display").waitFor({ state: "visible" });
  assert.equal(app.windows().length, 2);
  assert.equal(await main.getByRole("heading", { name: "Image controls", exact: true }).count(), 0);
  assert.equal(await main.locator(".research-inspector .source-display").count(), 0);
  const mounted = await main.evaluate((id) => {
    const vp = document.querySelector(`.image-viewport[data-viewer-source="${id}"]`);
    return { sameVp: vp === globalThis.__stageRefs.vp, sameCanvas: vp?.querySelector("canvas") === globalThis.__stageRefs.canvas, prepared: vp?.dataset.prepared };
  }, kidney.id);
  assert.deepEqual(mounted, { sameVp: true, sameCanvas: true, prepared: "true" });
  const scale0 = (await sampleCanvas(main, kidney.id)).camera.scale;
  await main.getByRole("button", { name: "Zoom in", exact: true }).click();
  await poll(async () => (await main.locator(`.image-viewport[data-viewer-source="${kidney.id}"]`).evaluate((e) => JSON.parse(e.dataset.camera).scale)) > scale0 * 1.05, "main zoom while detached");
  await main.getByRole("button", { name: "Fit image", exact: true }).click();
  await poll(async () => Math.abs((await main.locator(`.image-viewport[data-viewer-source="${kidney.id}"]`).evaluate((e) => JSON.parse(e.dataset.camera).scale)) - scale0) / scale0 < 0.05, "main fit while detached");
  await capture(main, "02-detached-main", "Main canvas mounted & interactive while Display detached");
  const detachedBaseline = await sampleCanvas(main, kidney.id);
  await capture(child, "03-detached-display-initial", "Detached Loci · Display initial state");
  report.passed.push("detached into Loci · Display while main canvas stayed mounted and usable");

  // 4. Detached scientific edits: Z 12/16, Ch1 opacity 0.35, hide Ch2 -> distinct main pixels + source_view.
  report.stage = "detached-edits";
  await setZ(child, targetZ, targetZText);
  const afterZ = await waitForDistinctCanvas(main, kidney.id, detachedBaseline, "Z 12/16");
  report.canvas.after_z12 = { ...stripProbe(afterZ.sample), delta: afterZ.delta };
  await openChannel(child, 1);
  await setFirstOpacity(child, 0.35);
  assert.equal((await child.getByLabel("Channel 1 opacity value", { exact: true }).textContent())?.trim(), "0.35");
  const afterOp = await waitForDistinctCanvas(main, kidney.id, afterZ.sample, "Ch1 opacity 0.35");
  report.canvas.after_ch1_opacity_035 = { ...stripProbe(afterOp.sample), delta: afterOp.delta };
  const ch2Box = child.getByRole("checkbox", { name: "Channel 2 visible", exact: true });
  assert.equal(await ch2Box.isChecked(), true, "Channel 2 must be visible before testing hide");
  await ch2Box.click();
  await poll(async () => !(await ch2Box.isChecked()), "hidden Channel 2 in the bound inspector");
  const afterHide = await waitForDistinctCanvas(main, kidney.id, afterOp.sample, "Ch2 hidden");
  report.canvas.after_ch2_hidden = { ...stripProbe(afterHide.sample), delta: afterHide.delta };
  await capture(child, "04-detached-display-edited", "Detached Display after Z=12/16, Ch1=0.35, Ch2 hidden");
  await capture(main, "05-main-after-detached-edits", "Main canvas updated from detached Display");

  const viewAfterDetached = await poll(async () => {
    const v = await getView(main, kidney.id);
    return v?.state?.selection?.z === targetZ && Math.abs((v.state.channels?.find((c) => c.channel === 0)?.opacity ?? 1) - 0.35) <= 1e-6 &&
      v.state.channels?.find((c) => c.channel === 1)?.visible === false ? v : null;
  }, "persisted source_view after detached edits");
  report.persisted.after_detached = assertView(viewAfterDetached, { id: kidney.id, sha: kidneySha, z: targetZ, ch0Opacity: 0.35, ch1Visible: false, count: 3 }, "detached source_view");
  report.passed.push("Z=12/16, Ch1 opacity=0.35, and Ch2 hidden produced distinct main pixels and exact source_view");

  // 5. Narrow and wide layout geometry on Loci · Display.
  report.stage = "narrow-wide-layout";
  const childWin = await app.browserWindow(child);
  const { bounds, minSize } = await childWin.evaluate((w) => ({ bounds: w.getBounds(), minSize: w.getMinimumSize() }));
  const wa = await app.evaluate(({ screen }, b) => screen.getDisplayMatching(b).workArea, bounds);
  const resize = (w, h) => childWin.evaluate((win, b) => win.setBounds(b), { x: wa.x + 20, y: wa.y + 20, width: w, height: h });
  await resize(Math.max(minSize[0], 320), Math.min(wa.height - 40, Math.max(minSize[1], 640)));
  report.layout.narrow = await checkLayout(child, "narrow");
  await capture(child, "06-detached-narrow", "Loci · Display narrow layout");
  await resize(Math.min(wa.width - 40, Math.max(minSize[0], 680)), Math.min(wa.height - 40, Math.max(minSize[1], 760)));
  report.layout.wide = await checkLayout(child, "wide");
  await capture(child, "07-detached-wide", "Loci · Display wide layout");
  await resize(Math.min(wa.width - 48, Math.max(minSize[0], 380)), Math.min(wa.height - 48, Math.max(minSize[1], 680)));
  report.passed.push("narrow and wide detached layouts passed non-overflow and non-overlap checks");

  // 6. Optional negative stale-source check with an explicitly pinned permitted second source.
  // Supports intentional dock-on-switch or clean rebind; proves old kidney source_view is untouched.
  let secondary = null, secondaryExpectedZ = 0;
  if (secondaryFile) {
    report.stage = "negative-stale-source";
    const kidneyRevBefore = viewAfterDetached.revision;
    await main.getByRole("button", { name: "Add images…", exact: true }).click();
    const snap2 = await waitForSnapshot(main, (s) => s?.sources?.length === 2, "secondary import", 60_000);
    secondary = snap2.sources.find((s) => s.id !== kidney.id);
    assert.equal(secondary?.sha256, secondarySha);
    report.fixtures.secondary.source_id = secondary.id;

    await main.locator(`${researchSourceButtonSelector}[data-source-id="${secondary.id}"]`).click();
    await sampleCanvas(main, secondary.id, false);
    const secDims = secondary.metadata.dimensions ?? { c: 1, z: 1 };
    const switchBehavior = await poll(async () => {
      if (child.isClosed() || app.windows().length === 1) return "auto-docked";
      const count = await child.locator('input[type="checkbox"][aria-label$=" visible"]').count().catch(() => -1);
      const zMax = secDims.z > 1 ? await child.getByRole("slider", { name: "Z plane", exact: true }).getAttribute("max").catch(() => null) : null;
      const matches = count === secDims.c && (secDims.z <= 1 || zMax === String(secDims.z - 1));
      if (matches && (!(secDims.c === 3 && secDims.z === 16) || (await zOut(child).textContent().catch(() => ""))?.trim() !== targetZText)) return "rebound";
      return null;
    }, "popup dock or rebind on source switch", 15_000);

    if (switchBehavior === "auto-docked") {
      child = null;
      await main.locator("fieldset.source-display-local:not([disabled])").waitFor({ state: "visible" });
      await main.getByRole("button", { name: "Detach Display", exact: true }).click();
      child = await waitForDisplayChild(app, main);
      await child.locator(".source-display").waitFor({ state: "visible" });
    }
    secondaryExpectedZ = secDims.z > 1 ? 1 : 0;
    if (secDims.z > 1) await setZ(child, secondaryExpectedZ, `${secondaryExpectedZ + 1} / ${secDims.z}`);
    await openChannel(child, 1);
    await setFirstOpacity(child, 0.55);
    const secView = await poll(async () => {
      const v = await getView(main, secondary.id);
      return v?.state?.selection?.z === secondaryExpectedZ && Math.abs((v.state.channels?.find((c) => c.channel === 0)?.opacity ?? 1) - 0.55) <= 1e-6 ? v : null;
    }, "secondary source_view");
    report.persisted.secondary = assertView(secView, { id: secondary.id, sha: secondarySha, z: secondaryExpectedZ, ch0Opacity: 0.55, count: secDims.c }, "secondary source_view");
    await capture(child, "08-detached-secondary", "Loci · Display bound to secondary source");

    assertView(await getView(main, kidney.id), { id: kidney.id, sha: kidneySha, exactRev: kidneyRevBefore, z: targetZ, ch0Opacity: 0.35, ch1Visible: false, count: 3 }, "kidney untouched after secondary edits");
    report.negative_stale_source = { switch_behavior: switchBehavior, kidney_revision_unchanged: kidneyRevBefore };

    await main.locator(`${researchSourceButtonSelector}[data-source-id="${kidney.id}"]`).click();
    await sampleCanvas(main, kidney.id);
    await poll(() => child.isClosed() || app.windows().length === 1 || child.getByRole("slider", { name: "Z plane", exact: true }).inputValue().then((v) => v === String(targetZ), () => false), "return to kidney");
    if (child.isClosed() || app.windows().length === 1) {
      child = null;
      await main.locator("fieldset.source-display-local:not([disabled])").waitFor({ state: "visible" });
      await main.getByRole("button", { name: "Detach Display", exact: true }).click();
      child = await waitForDisplayChild(app, main);
      await child.locator(".source-display").waitFor({ state: "visible" });
    }
    report.passed.push(`second-source isolation (${switchBehavior}) preserved kidney source_view untouched`);
  }

  // 7. Dock via "Dock Display" command; verify retained settings and focus return.
  report.stage = "dock-command";
  const dockHost = (await child.getByRole("button", { name: "Dock Display", exact: true }).count()) > 0 ? child : main;
  await dockHost.getByRole("button", { name: "Dock Display", exact: true }).first().click();
  await poll(() => app.windows().length === 1 && child.isClosed(), "child close via Dock Display");
  child = null;
  await mainDisplay.waitFor({ state: "visible" });
  report.focus.after_dock_command = await expectFocusOnDetach(main, "Dock Display command");
  await assertKidneyPanel(mainDisplay, "0.35");
  await capture(main, "09-docked-after-command", "Docked Display after Dock Display command");
  report.passed.push("Dock Display command closed child, retained settings, and returned focus");

  // 8. Re-detach, edit Ch1 opacity -> 0.42, then dock via native BrowserWindow.close().
  report.stage = "dock-native-close";
  if (drag) child = await dragPanel("Detach Display", childTitle, "left");
  else await button(main, "Detach Display").click();
  child = await waitForDisplayChild(app, main);
  await child.locator(".source-display").waitFor({ state: "visible" });
  await openChannel(child, 1);
  await setFirstOpacity(child, 0.42);
  const after042 = await waitForDistinctCanvas(main, kidney.id, afterHide.sample, "Ch1 opacity 0.42", 0.001, 0.1);
  report.canvas.after_ch1_opacity_042 = { ...stripProbe(after042.sample), delta: after042.delta };
  await poll(async () => Math.abs(((await getView(main, kidney.id))?.state?.channels?.find((c) => c.channel === 0)?.opacity ?? 1) - 0.42) <= 1e-6, "persisted opacity 0.42");
  await (await app.browserWindow(child)).evaluate((w) => w.close());
  await poll(() => app.windows().length === 1 && child.isClosed(), "child close via native window.close()");
  child = null;
  await mainDisplay.waitFor({ state: "visible" });
  report.focus.after_native_close = await expectFocusOnDetach(main, "Native close");
  await assertKidneyPanel(mainDisplay, "0.42");
  await capture(main, "10-docked-after-native-close", "Docked Display after native close with Ch1=0.42");
  report.passed.push("native close docked Display, retained opacity=0.42, and returned focus");

  // 9. Save study, independent SQLite readback, quit, and cold reopen in fresh profile.
  report.stage = "save-and-cold-reopen";
  await main.getByRole("button", { name: "Save study", exact: true }).click();
  await poll(() => fs.stat(path.join(studyPath, "study.sqlite3")).then((s) => s.size > 0, () => false), "study.sqlite3 saved", 60_000);
  report.persisted.sqlite_kidney = assertView(readSqliteDisplay(studyPath, kidney.id), { id: kidney.id, sha: kidneySha, z: targetZ, ch0Opacity: 0.42, ch1Visible: false, count: 3 }, "SQLite kidney");
  if (secondary) report.persisted.sqlite_secondary = assertView(readSqliteDisplay(studyPath, secondary.id), { id: secondary.id, sha: secondarySha, z: secondaryExpectedZ, ch0Opacity: 0.55 }, "SQLite secondary");
  await closeWithConfirmedQuit(app);
  app = main = null;

  ({ launched: app, first: main } = await launch("reopen", { reopen: true }));
  await main.getByRole("button", { name: "Open study", exact: true }).click();
  const reopenedSnap = await waitForSnapshot(main, (s) => s?.sources?.some((x) => x.sha256 === kidneySha), "reopened study", 90_000);
  assert.equal(reopenedSnap.sources.find((x) => x.sha256 === kidneySha).id, kidney.id);
  await main.locator(`${researchSourceButtonSelector}[data-source-id="${kidney.id}"]`).click();
  await selectWorkbenchTool(main, "Display");
  await main.locator("fieldset.source-display-local:not([disabled])").waitFor({ state: "visible" });
  await main.getByRole("button", { name: "Fit image", exact: true }).click();
  await assertKidneyPanel(main.locator(".research-inspector .source-display"), "0.42");
  report.persisted.cold_reopen = assertView(await getView(main, kidney.id), { id: kidney.id, sha: kidneySha, z: targetZ, ch0Opacity: 0.42, ch1Visible: false, count: 3 }, "cold reopen source_view");
  const reopenCanvas = await sampleCanvas(main, kidney.id);
  report.canvas.cold_reopen = { ...stripProbe(reopenCanvas), delta_from_baseline: diffCanvas(baseline, reopenCanvas, "cold reopen vs baseline") };
  await capture(main, "11-cold-reopen", "Cold-reopened saved study retaining detached Display edits");
  if (drag) await checkAdditionalDragRoutes(kidney, secondary);
  await closeWithConfirmedQuit(app);
  app = main = null;
  report.passed.push("independent SQLite readback and cold study reopen retained exact kidney Display state");

  // 10. Raw source immutability & zero errors.
  report.stage = "final-integrity";
  const kidneyAfter = await statPlain(kidneyFile, "Public kidney fixture (after)");
  assert.deepEqual([kidneyAfter.sha256, kidneyAfter.size, kidneyAfter.mtimeMs], [kidneyBefore.sha256, kidneyBefore.size, kidneyBefore.mtimeMs]);
  report.fixtures.kidney.unchanged = true;
  if (secondaryFile) {
    const secAfter = await statPlain(secondaryFile, "Secondary fixture (after)");
    assert.deepEqual([secAfter.sha256, secAfter.size, secAfter.mtimeMs], [secondaryBefore.sha256, secondaryBefore.size, secondaryBefore.mtimeMs]);
    report.fixtures.secondary.unchanged = true;
  }
  assert.deepEqual(report.renderer_errors, [], "Renderer pageerrors occurred.");
  assert.deepEqual(report.console_errors, [], "Console errors occurred.");
  assert.deepEqual(report.blocked_requests, [], "Unexpected renderer HTTP(S) requests occurred.");
  report.status = "passed";
  report.stage = "complete";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.error = redact(error?.stack ?? error);
  if (main && !main.isClosed()) await capture(main, "98-failure-main", "Main window at failure").catch(() => {});
  if (child && !child.isClosed()) await capture(child, "99-failure-child", "Loci · Display at failure").catch(() => {});
} finally {
  if (app) await closeWithConfirmedQuit(app).catch((e) => { report.close_error = redact(e); failure ??= e; });
  report.finished_at = new Date().toISOString();
  await saveReport();
}
if (failure) throw new Error(`Detached Display QA failed at ${report.stage}. Report: ${reportPath}`, { cause: failure });
console.log(JSON.stringify({ status: report.status, runRoot, reportPath, passed: report.passed.length }));
