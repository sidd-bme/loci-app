import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const publicRoot = path.resolve(process.env.LOCI_QA_PUBLIC_FIXTURES ??
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/public-fixtures"));
const phasePath = path.join(publicRoot, "Phase cell.ome.tiff");
const phaseOriginalPath = path.join(publicRoot, "cell.png");
const kidneyPath = path.join(publicRoot, "Kidney fluorescence.ome.tiff");
const provenancePath = path.join(publicRoot, "provenance.json");
const wsiPath = path.resolve(process.env.LOCI_QA_PUBLIC_WSI ??
  "/tmp/loci-release-run/wsi/CMU-1-Small-Region.svs");
const wsiIndexPath = path.resolve(process.env.LOCI_QA_PUBLIC_WSI_INDEX ??
  "/tmp/loci-release-run/wsi/openslide-index.json");
const qualificationRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ??
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/public-visual"));
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(qualificationRoot, runName);
const screenshots = path.join(runRoot, "screenshots");
const userData = path.join(runRoot, "user-data");

const packagedInput = process.env.LOCI_PACKAGED_APP ?? process.env.LOCI_QA_APP ?? null;
if (process.env.LOCI_PACKAGED_APP && process.env.LOCI_QA_APP &&
    process.env.LOCI_PACKAGED_APP !== process.env.LOCI_QA_APP)
  throw new Error("LOCI_PACKAGED_APP and its LOCI_QA_APP alias disagree.");
if (packagedInput && !path.isAbsolute(packagedInput))
  throw new Error("LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
const packagedApp = packagedInput ? path.resolve(packagedInput) : null;
const packaged = packagedApp !== null;
if (packaged === (process.env.LOCI_QA_DEV === "1"))
  throw new Error("Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.");

const executablePath = packaged
  ? path.join(packagedApp, "Contents", "MacOS", "Loci")
  : path.join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const workerPath = packaged
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const applicationArtifact = packaged
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const workerClientSource = path.join(desktopRoot, "src", "main", "worker-client.ts");
const workerModuleSource = path.join(projectRoot, "engine", "src", "loci_engine", "worker.py");
const independentPython = path.join(projectRoot, "engine", ".venv", "bin", "python");

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This public visual journey qualifies Apple-silicon macOS.");
await fs.mkdir(screenshots, { recursive: true });
await Promise.all([
  fs.access(phasePath), fs.access(phaseOriginalPath), fs.access(kidneyPath),
  fs.access(provenancePath), fs.access(wsiPath), fs.access(wsiIndexPath),
  fs.access(executablePath), fs.access(workerPath), fs.access(applicationArtifact),
  fs.access(independentPython),
]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const expectedHashes = {
  phase: "f5f1565e990650a87cabf7e6e8db1fd6da40b430b5fab52e3f598314d428cf76",
  phase_original: "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515",
  kidney: "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564",
  wsi: "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7",
};
const observedHashes = {
  phase: await sha256(phasePath), phase_original: await sha256(phaseOriginalPath),
  kidney: await sha256(kidneyPath), wsi: await sha256(wsiPath),
};
assert.deepEqual(observedHashes, expectedHashes, "A public fixture identity changed.");
const publicProvenance = JSON.parse(await fs.readFile(provenancePath, "utf8"));
const wsiIndex = JSON.parse(await fs.readFile(wsiIndexPath, "utf8"));
assert.equal(wsiIndex["Aperio/CMU-1-Small-Region.svs"]?.license, "CC0-1.0");
assert.equal(wsiIndex["Aperio/CMU-1-Small-Region.svs"]?.sha256, expectedHashes.wsi);

const buildIdentity = {
  mode: packaged ? "packaged-binary" : "python-module:loci_engine.worker",
  executable_sha256: await sha256(executablePath),
  worker_sha256: await sha256(workerPath),
  application_artifact_sha256: await sha256(applicationArtifact),
  worker_command: packaged
    ? { executable: workerPath, args: [], cwd: null }
    : { executable: workerPath, args: ["-m", "loci_engine.worker"], cwd: path.join(projectRoot, "engine") },
  ...(packaged ? {} : {
    worker_client_source_sha256: await sha256(workerClientSource),
    worker_module_source_sha256: await sha256(workerModuleSource),
  }),
};
const sourceIdentity = {
  head: (await run("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim(),
  head_tree: (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: projectRoot })).stdout.trim(),
  status: (await run("git", ["status", "--porcelain"], { cwd: projectRoot })).stdout.trim(),
  harness_sha256: await sha256(import.meta.filename),
  workbench_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx")),
  viewport_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "ImageViewport.tsx")),
  welcome_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "WorkbenchChrome.tsx")),
};

const captures = {};
let phaseSegmentation = null;
const consoleErrors = [];
const pageErrors = [];
const networkRequests = [];
const startedAt = new Date().toISOString();
const started = performance.now();
let app;
let page;

async function capture(name, locator = page) {
  const file = path.join(screenshots, `${name}.png`);
  const bytes = await locator.screenshot({ path: file });
  assert.ok(bytes.length > 2_000, `${name} was not a substantive capture.`);
  captures[name] = { file: path.basename(file), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function launch() {
  const instance = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [desktopRoot]), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const window = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1230, height: 820 }));
  await window.locator("main.image-first-empty, main.research-workbench").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  window.on("request", (request) => { if (/^https?:/i.test(request.url())) networkRequests.push(request.url()); });
  return { instance, window };
}

async function close() {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => undefined);
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await closed;
  app = undefined;
  page = undefined;
}

async function installOpenDialog() {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images")
        return { canceled: false, filePaths: paths };
      return { canceled: true, filePaths: [] };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, [phasePath, kidneyPath, wsiPath]);
}

async function setContentViewport(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height,
    { width, height });
}

async function auditWelcomeGeometry(label) {
  const geometry = await page.evaluate(() => {
    const main = document.querySelector("main.image-first-empty");
    const welcome = document.querySelector(".image-welcome");
    const heading = welcome?.querySelector("h1");
    const primary = welcome?.querySelector(".welcome-open");
    const options = welcome?.querySelector(".welcome-options-toggle");
    const recent = welcome?.querySelector(".recent-sessions");
    const tips = welcome?.querySelector(".welcome-tips");
    const actions = [...(welcome?.querySelectorAll(".welcome-main-actions > button") ?? [])];
    const boxes = [welcome, heading, primary, options, recent, tips, ...actions].map((element) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height } : null;
    });
    const actionTops = actions.map((element) => element.getBoundingClientRect().top);
    const panelTops = [recent, tips].map((element) => element?.getBoundingClientRect().top ?? null);
    return { boxes, heading_text: heading?.textContent?.trim() ?? "",
      action_count: actions.length, action_tops: actionTops, panel_tops: panelTops,
      recent_empty: recent?.querySelector(".recent-empty")?.textContent?.trim() ?? "",
      viewport: { width: innerWidth, height: innerHeight },
      document_width: document.documentElement.scrollWidth,
      main_width: main?.getBoundingClientRect().width ?? 0 };
  });
  assert.ok(geometry.main_width > 0, `${label}: welcome main is absent.`);
  assert.equal(geometry.heading_text, "Open data", `${label}: welcome heading is not functional.`);
  assert.equal(geometry.action_count, 3, `${label}: main opening action row is incomplete.`);
  assert.ok(Math.max(...geometry.action_tops) - Math.min(...geometry.action_tops) <= 1,
    `${label}: main opening actions are not in one row.`);
  assert.ok(geometry.panel_tops.every((top) => top !== null) &&
    Math.abs(geometry.panel_tops[0] - geometry.panel_tops[1]) <= 1,
  `${label}: recent work and research tips are not aligned.`);
  assert.match(geometry.recent_empty, /No recent work yet/,
    `${label}: recent work lacks its truthful empty state.`);
  assert.ok(geometry.document_width <= geometry.viewport.width + 1, `${label}: horizontal overflow.`);
  for (const box of geometry.boxes) {
    assert.ok(box && box.width > 0 && box.height > 0, `${label}: empty welcome element.`);
    assert.ok(box.left >= 0 && box.right <= geometry.viewport.width + 1,
      `${label}: welcome element is clipped horizontally.`);
    assert.ok(box.top >= 0 && box.bottom <= geometry.viewport.height + 1,
      `${label}: welcome element is clipped vertically.`);
  }
  return geometry;
}

async function waitForViewer(sourceName) {
  const viewer = page.getByLabel(`Image viewer: ${sourceName}`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction((name) => {
    const element = [...document.querySelectorAll(".image-viewport")].find(
      (item) => item.getAttribute("aria-label") === `Image viewer: ${name}`);
    return element && Number(element.getAttribute("data-cache-bytes")) > 0 &&
      !element.querySelector(".image-view-loading");
  }, sourceName, { timeout: 120_000 });
  const alert = page.locator('.research-alert[role="alert"]');
  assert.equal(await alert.isVisible().catch(() => false), false,
    `Loci reported an error while opening ${sourceName}.`);
  return viewer;
}

async function waitForRawVolume(source) {
  const volume = page.getByRole("region", { name: "Raw whole-volume viewport", exact: true });
  await volume.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction((expected) => {
    const element = document.querySelector(".raw-volume");
    return element?.getAttribute("data-source-id") === expected.id &&
      element.getAttribute("data-source-sha256") === expected.sha256 &&
      Number(element.getAttribute("data-context-byte-length")) > 0 &&
      !element.querySelector(".raw-volume-status")?.textContent?.includes("Loading");
  }, { id: source.id, sha256: source.sha256 }, { timeout: 120_000 });
  return volume;
}

async function assertPublicCaptureReady(label) {
  assert.equal(await page.locator("details.source-information[open]").count(), 0,
    `${label}: image-information panel is open and may expose source metadata.`);
  assert.equal(await page.locator("details.analysis-region-settings[open]").count(), 0,
    `${label}: the advanced analysis-region panel is open in a public workspace capture.`);
  assert.equal(await page.getByRole("dialog").count(), 0,
    `${label}: a dialog obscures the workspace capture.`);
}

async function closeAnalysisRegionForPublicCapture() {
  const details = page.locator("details.analysis-region-settings");
  if (await details.count() && await details.evaluate((element) => element.open))
    await details.locator(":scope > summary").click();
}

function decodeDataPng(value) {
  const prefix = "data:image/png;base64,";
  assert.ok(value.startsWith(prefix), "The viewer response was not an inline PNG.");
  return Buffer.from(value.slice(prefix.length), "base64");
}

try {
  ({ instance: app, window: page } = await launch());
  const primary = page.getByRole("button", { name: "Open images", exact: true });
  const options = page.getByRole("button", { name: "More opening options", exact: true });
  await primary.evaluate((element) => { element.dataset.qaIdentity = "stable-primary"; });
  const regionId = await options.getAttribute("aria-controls");
  assert.ok(regionId);
  assert.equal(await page.locator(`#${regionId}`).getAttribute("inert"), "");
  await options.click();
  assert.equal(await options.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(`#${regionId}`).getAttribute("inert"), null);
  assert.equal(await primary.getAttribute("data-qa-identity"), "stable-primary",
    "Opening the progressive options replaced the main action.");
  assert.ok(await page.locator(`#${regionId} .welcome-source-option`).count() >= 3,
    "The More sources strip lacks the explicit source routes.");
  await capture("01-welcome-options-open");
  await options.click();
  assert.equal(await page.locator(`#${regionId}`).getAttribute("inert"), "");

  const emblem = page.getByRole("button", {
    name: "Activate the Loci optical phase pulse",
    exact: true,
  });
  const mark = emblem.locator(".brand-mark");
  await emblem.focus();
  assert.equal(await emblem.evaluate((element) => document.activeElement === element), true,
    "The optical phase control is not keyboard focusable.");
  await capture("02-welcome-logo-focus", page.locator(".image-welcome"));
  await emblem.hover();
  await page.waitForTimeout(160);
  const hoverState = await emblem.evaluate((element) => {
    const button = getComputedStyle(element);
    const logo = getComputedStyle(element.querySelector(".brand-mark"));
    return { background: button.backgroundColor, border: button.borderTopWidth,
      button_scale: button.scale, logo_scale: logo.scale, logo_filter: logo.filter };
  });
  assert.equal(hoverState.background, "rgba(0, 0, 0, 0)",
    "Logo hover painted a large button backplate.");
  assert.equal(hoverState.border, "0px", "Logo hover painted a border or ring.");
  assert.ok(Number(hoverState.logo_scale) >= 1.01 && Number(hoverState.logo_scale) <= 1.02,
    `Logo hover scale is not restrained: ${hoverState.logo_scale}`);
  assert.notEqual(hoverState.logo_filter, "none", "Logo hover has no subtle optical response.");
  const emblemBounds = await emblem.boundingBox();
  assert.ok(emblemBounds, "The optical phase control has no rendered bounds.");
  await page.mouse.move(emblemBounds.x + emblemBounds.width / 2,
    emblemBounds.y + emblemBounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  const pressedState = await emblem.evaluate((element) => ({
    button_scale: getComputedStyle(element).scale,
    logo_scale: getComputedStyle(element.querySelector(".brand-mark")).scale,
  }));
  assert.equal(Number(pressedState.button_scale), 1,
    "The logo hit area compressed with the mark.");
  assert.ok(Number(pressedState.logo_scale) >= .95 && Number(pressedState.logo_scale) <= .97,
    `Logo press scale is not tactile and restrained: ${pressedState.logo_scale}`);
  await capture("03-welcome-logo-pressed", page.locator(".image-welcome"));
  await page.mouse.up();
  await emblem.evaluate((element) => {
    for (let index = 0; index < 12; index += 1) element.click();
  });
  await page.waitForFunction(() => document.querySelectorAll(".welcome-phase-pulse").length === 6,
    undefined, { timeout: 3_000 });
  const pulseState = await emblem.evaluate((element) =>
    [...element.querySelectorAll(".welcome-phase-pulse")].map((item, index) => {
      const animation = item.getAnimations()[0];
      if (animation) { animation.pause(); animation.currentTime = 80 + index * 70; }
      return item.getAttribute("data-pulse-id");
    }));
  assert.equal(pulseState.length, 6);
  assert.equal(new Set(pulseState).size, 6, "Rapid logo activations did not remain independent.");
  await capture("04-welcome-phase-pulses-bounded", page.locator(".image-welcome"));
  await emblem.evaluate((element) => {
    for (const item of element.querySelectorAll(".welcome-phase-pulse"))
      for (const animation of item.getAnimations()) animation.play();
  });
  await page.waitForFunction(() =>
    document.querySelectorAll(".welcome-phase-pulse").length === 0,
  undefined, { timeout: 3_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await emblem.click();
  assert.equal(await emblem.locator(".welcome-phase-pulse").count(), 0,
    "Reduced motion still created a decorative phase pulse.");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const tips = page.getByRole("region", { name: "Research tips" });
  await tips.focus();
  assert.equal(await tips.evaluate((element) => document.activeElement === element), true,
    "The research tips region is not keyboard focusable.");
  await tips.getByRole("button", { name: "Next tip", exact: true }).click();
  await page.getByText("Inspect a DICOM series", { exact: true }).waitFor();
  await tips.press("ArrowRight");
  await page.getByText("Open local multiscale data", { exact: true }).waitFor();
  await tips.press("ArrowLeft");
  await page.getByText("Inspect a DICOM series", { exact: true }).waitFor();
  await tips.press("Home");
  await page.getByText("Drag and drop to open", { exact: true }).waitFor();
  for (const shortcut of ["TIFF", "OME-TIFF", "PNG", "JPEG", "DICOM", "OME-Zarr"])
    assert.equal(await tips.getByRole("button", { name: shortcut, exact: true }).isEnabled(), true,
      `${shortcut} shortcut is unavailable.`);

  await page.evaluate(() => {
    const target = document.querySelector("main.image-first-empty");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["qa"], "drag-probe.tif", { type: "image/tiff" }));
    target.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
  });
  await page.getByRole("heading", { name: "Drop to open" }).waitFor();
  await capture("05-welcome-drag-over");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.getByRole("heading", { name: "Open data" }).waitFor();

  const themeGeometry = {};
  let captureIndex = 6;
  for (const viewport of [{ width: 1024, height: 720 }, { width: 1440, height: 900 }]) {
    await setContentViewport(viewport.width, viewport.height);
    for (const theme of ["Graphite", "Midnight", "Paper"]) {
      for (const textSize of ["Standard", "Large"]) {
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("combobox", { name: "Application theme" }).selectOption(theme.toLowerCase());
        await dialog.getByRole("radio", { name: new RegExp(`^${textSize}`) }).click();
        await dialog.getByRole("button", { name: "Done" }).click();
        const key = `${viewport.width}x${viewport.height}-${theme.toLowerCase()}-${textSize.toLowerCase()}`;
        await page.waitForFunction(([themeId, sizeId]) =>
          document.documentElement.dataset.theme === themeId &&
          document.documentElement.dataset.textSize === sizeId,
        [theme.toLowerCase(), textSize.toLowerCase()]);
        themeGeometry[key] = await auditWelcomeGeometry(key);
        await capture(`${String(captureIndex++).padStart(2, "0")}-welcome-${key}`);
      }
    }
  }

  await installOpenDialog();
  await primary.click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 120_000 });
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(snapshot.sources.length, 3);
  const phaseName = path.basename(phasePath), kidneyName = path.basename(kidneyPath), wsiName = path.basename(wsiPath);
  const byName = Object.fromEntries(snapshot.sources.map((source) => [source.name, source]));
  assert.equal(byName[phaseName]?.sha256, expectedHashes.phase);
  assert.equal(byName[kidneyName]?.sha256, expectedHashes.kidney);
  assert.equal(byName[wsiName]?.sha256, expectedHashes.wsi);
  const sourceButton = (name) => page.locator(".research-sources").getByRole("button", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });

  await sourceButton(phaseName).click();
  const phaseViewer = await waitForViewer(phaseName);
  const imageInformation = page.locator("details.source-information");
  const imageInformationSummary = imageInformation.locator("summary");
  await imageInformationSummary.click();
  const closeImageInformation = imageInformation.getByRole("button", {
    name: "Close image information",
    exact: true,
  });
  await closeImageInformation.waitFor();
  const informationGeometry = await imageInformation.evaluate((details) => {
    const inspector = details.closest(".research-inspector");
    const content = details.querySelector(".source-information-content");
    const closeButton = details.querySelector('button[aria-label="Close image information"]');
    const inspectorBox = inspector?.getBoundingClientRect();
    const contentBox = content?.getBoundingClientRect();
    const closeBox = closeButton?.getBoundingClientRect();
    const style = content ? getComputedStyle(content) : null;
    return { open: details.open, inspectorBox, contentBox, closeBox,
      overflowY: style?.overflowY, maxHeight: style?.maxHeight,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  assert.equal(informationGeometry.open, true, "Image information did not open in the real app.");
  assert.ok(informationGeometry.inspectorBox && informationGeometry.contentBox &&
    informationGeometry.closeBox, "Image information geometry is incomplete.");
  assert.ok(informationGeometry.contentBox.left >= informationGeometry.inspectorBox.left - 1 &&
    informationGeometry.contentBox.right <= informationGeometry.inspectorBox.right + 1,
  "Image information overflows the inspector horizontally.");
  assert.ok(informationGeometry.closeBox.left >= informationGeometry.contentBox.left &&
    informationGeometry.closeBox.right <= informationGeometry.contentBox.right,
  "Image information close action is clipped.");
  assert.equal(informationGeometry.overflowY, "auto");
  assert.notEqual(informationGeometry.maxHeight, "none");
  assert.ok(informationGeometry.documentWidth <= informationGeometry.viewportWidth + 1,
    "Image information caused page-level horizontal overflow.");
  await capture(`${String(captureIndex++).padStart(2, "0")}-public-phase-image-information`,
    page.locator(".research-inspector"));
  await closeImageInformation.click();
  assert.equal(await imageInformation.getAttribute("open"), null);
  assert.equal(await imageInformationSummary.evaluate((element) => document.activeElement === element), true,
    "Closing image information did not restore focus to its summary.");
  await imageInformationSummary.click();
  await imageInformationSummary.focus();
  await imageInformationSummary.press("Escape");
  assert.equal(await imageInformation.getAttribute("open"), null,
    "Escape did not close image information.");
  assert.equal(await imageInformationSummary.evaluate((element) => document.activeElement === element), true,
    "Escape did not restore focus to the image information summary.");
  await capture(`${String(captureIndex++).padStart(2, "0")}-public-phase-fit`, phaseViewer);
  await assertPublicCaptureReady("direct phase opening");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-direct-opening-phase`);
  const phaseSelection = { x: 29, y: 31, width: 127, height: 113, z: 0, t: 0, c: 0, level: 0 };
  const phaseTile = await page.evaluate(async ({ sourceId, selection }) =>
    window.lociResearch.execute("viewer_tile", { source_id: sourceId, selection,
      channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }] }),
  { sourceId: byName[phaseName].id, selection: phaseSelection });
  assert.equal(phaseTile.source_sha256, expectedHashes.phase);
  assert.deepEqual(phaseTile.selection, phaseSelection);
  const phaseLociPng = path.join(runRoot, "phase-loci-region.png");
  await fs.writeFile(phaseLociPng, decodeDataPng(phaseTile.image));

  // This is deliberately a user-created, source-bound annotation on the raw
  // phase display. It is illustrative QA evidence, not a biological label.
  await selectWorkbenchTool(page, "Annotate");
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await page.getByLabel("Annotation label", { exact: true }).fill("Illustrative QA region");
  const phaseCanvas = phaseViewer.getByLabel("Source image and bound annotations");
  await phaseCanvas.click({ position: { x: 260, y: 210 } });
  await phaseCanvas.click({ position: { x: 470, y: 365 } });
  await page.getByRole("button", { name: "Save annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor({ timeout: 30_000 });
  const phaseAnnotation = await page.evaluate(async (sourceId) =>
    window.lociResearch.execute("source_annotations", { source_id: sourceId }), byName[phaseName].id);
  assert.equal(phaseAnnotation.source_id, byName[phaseName].id);
  assert.equal(phaseAnnotation.source_sha256, expectedHashes.phase);
  assert.equal(phaseAnnotation.annotations.length, 1);
  assert.equal(phaseAnnotation.annotations[0].kind, "rectangle");
  assert.equal(phaseAnnotation.annotations[0].label, "Illustrative QA region");
  for (const point of phaseAnnotation.annotations[0].points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) &&
      point.x >= 0 && point.x < byName[phaseName].metadata.dimensions.x &&
      point.y >= 0 && point.y < byName[phaseName].metadata.dimensions.y,
    "The saved annotation point lies outside the displayed phase source grid.");
  }
  await assertPublicCaptureReady("phase annotation");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-phase-raw-annotation`);

  // Run the built-in method through the visible UI. Record the result actually
  // returned by this fixture; no precomputed result or success report is used.
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  const segment = page.getByRole("button", { name: "Segment image", exact: true });
  await segment.waitFor({ state: "visible", timeout: 30_000 });
  const resultIdsBefore = await page.evaluate(() => window.lociResearch.getSnapshot().then((snapshot) =>
    snapshot.results.map((result) => result.id)));
  await segment.click();
  const resultDeadline = performance.now() + 120_000;
  let phaseSegmentationSummary = null;
  while (!phaseSegmentationSummary && performance.now() < resultDeadline) {
    phaseSegmentationSummary = await page.evaluate(async ({ sourceId, before }) => {
      const snapshot = await window.lociResearch.getSnapshot();
      const result = snapshot.results.find((item) => item.source_id === sourceId && !before.includes(item.id));
      return result ? { id: result.id, kind: result.kind, object_count: result.object_count } : null;
    }, { sourceId: byName[phaseName].id, before: resultIdsBefore });
    if (!phaseSegmentationSummary) await page.waitForTimeout(100);
  }
  assert.ok(phaseSegmentationSummary, "Adaptive segmentation did not create a result in the public fixture.");
  const phaseResultRecord = await page.evaluate(async (resultId) =>
    window.lociResearch.execute("result", { result_id: resultId, offset: 0, limit: 1 }), phaseSegmentationSummary.id);
  assert.equal(phaseResultRecord.result.source_id, byName[phaseName].id);
  assert.equal(phaseResultRecord.result.source_sha256, expectedHashes.phase);
  assert.deepEqual(phaseResultRecord.result.selection, phaseResultRecord.provenance.selection);
  assert.equal(phaseResultRecord.provenance.segmentation?.method, "loci-adaptive-watershed");
  assert.deepEqual(phaseResultRecord.provenance.settings,
    phaseResultRecord.provenance.accepted_request?.settings,
    "The accepted adaptive settings differ from saved result provenance.");
  phaseSegmentation = {
    ...phaseSegmentationSummary,
    source_sha256: phaseResultRecord.result.source_sha256,
    selection: phaseResultRecord.provenance.selection,
    accepted_request: phaseResultRecord.provenance.accepted_request,
    settings: phaseResultRecord.provenance.settings,
    segmentation: phaseResultRecord.provenance.segmentation,
    profile: phaseResultRecord.provenance.profile,
    runtime: phaseResultRecord.provenance.runtime,
  };
  await page.getByText(/Result on source/).waitFor({ timeout: 120_000 });
  await assertPublicCaptureReady("phase segmentation");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-phase-illustrative-segmentation`);

  await sourceButton(wsiName).click();
  const wsiViewer = await waitForViewer(wsiName);
  await selectWorkbenchTool(page, "Display");
  await closeAnalysisRegionForPublicCapture();
  await capture(`${String(captureIndex++).padStart(2, "0")}-public-wsi-fit`, wsiViewer);
  const wsiCameraBeforeNativeZoom = await wsiViewer.getAttribute("data-camera");
  await wsiViewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  await page.waitForFunction(({ name, previousCamera }) => {
    const viewer = document.querySelector(`[aria-label="Image viewer: ${CSS.escape(name)}"]`);
    return viewer?.getAttribute("data-auto-level") === "0" &&
      viewer.getAttribute("data-camera") !== previousCamera;
  }, { name: wsiName, previousCamera: wsiCameraBeforeNativeZoom }, { timeout: 120_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await waitForViewer(wsiName);
  await wsiViewer.getByLabel("Native pixel zoom", { exact: true }).filter({ hasText: /^100%$/ }).waitFor();
  await capture(`${String(captureIndex++).padStart(2, "0")}-public-wsi-native`, wsiViewer);
  await assertPublicCaptureReady("native SVS");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-native-svs-histology`);
  const wsiSelection = { x: 37, y: 53, width: 127, height: 113, z: 0, t: 0, c: 0, level: 0 };
  const wsiTile = await page.evaluate(async ({ sourceId, selection }) =>
    window.lociResearch.execute("viewer_tile", { source_id: sourceId, selection,
      channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }] }),
  { sourceId: byName[wsiName].id, selection: wsiSelection });
  assert.equal(wsiTile.source_sha256, expectedHashes.wsi);
  assert.deepEqual(wsiTile.selection, wsiSelection);
  const wsiLociPng = path.join(runRoot, "wsi-loci-region.png");
  await fs.writeFile(wsiLociPng, decodeDataPng(wsiTile.image));

  await sourceButton(kidneyName).click();
  const kidneyViewer = await waitForViewer(kidneyName);
  const inspector = page.locator(".research-inspector");
  await inspector.getByRole("button", { name: "View", exact: true }).click();
  await closeAnalysisRegionForPublicCapture();
  await inspector.getByRole("button", { name: "Auto", exact: true }).click();
  const kidneyZ = inspector.getByLabel("Z plane", { exact: true });
  await kidneyZ.focus();
  await kidneyZ.press("Home");
  for (let index = 0; index < 8; index += 1) await kidneyZ.press("ArrowRight");
  await page.getByText(/Z 9 \/ /).waitFor({ timeout: 30_000 });
  assert.equal(await kidneyZ.inputValue(), "8", "The visible Z-plane control did not select zero-based plane 8.");
  await waitForViewer(kidneyName);
  const kidneyTile = await page.evaluate(async ({ sourceId }) => window.lociResearch.execute("viewer_tile", {
    source_id: sourceId, selection: { x: 0, y: 0, width: 64, height: 64, z: 8, t: 0, c: 0, level: 0 },
    channels: [{ channel: 0, low: 0, high: 65535, gamma: 1, color: "#ffffff", opacity: 1, visible: true }],
  }), { sourceId: byName[kidneyName].id });
  assert.equal(kidneyTile.source_sha256, expectedHashes.kidney);
  assert.equal(kidneyTile.selection.z, 8);
  await capture(`${String(captureIndex++).padStart(2, "0")}-public-kidney-z9-auto`, kidneyViewer);
  await assertPublicCaptureReady("multichannel kidney");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-multichannel-kidney`);
  await page.getByRole("button", { name: "3D volume", exact: true }).click();
  const kidneyVolume = await waitForRawVolume(byName[kidneyName]);
  assert.ok(Number(await kidneyVolume.getAttribute("data-context-byte-length")) > 0,
    "The kidney raw-volume capture has no bounded source context.");
  await assertPublicCaptureReady("raw kidney volume");
  await capture(`${String(captureIndex++).padStart(2, "0")}-readme-raw3d-kidney`);

  const comparisonScript = path.join(runRoot, "independent_public_comparison.py");
  const comparisonReport = path.join(runRoot, "numerical-comparison.json");
  const phaseReferencePng = path.join(runRoot, "phase-independent-reference.png");
  const wsiReferencePng = path.join(runRoot, "wsi-independent-reference.png");
  await fs.writeFile(comparisonScript, String.raw`import hashlib
import json
from pathlib import Path
import numpy as np
import openslide
from PIL import Image
import tifffile

phase_source = Path(${JSON.stringify(phasePath)})
phase_original = Path(${JSON.stringify(phaseOriginalPath)})
phase_loci = Path(${JSON.stringify(phaseLociPng)})
phase_reference = Path(${JSON.stringify(phaseReferencePng)})
wsi_source = Path(${JSON.stringify(wsiPath)})
wsi_loci = Path(${JSON.stringify(wsiLociPng)})
wsi_reference = Path(${JSON.stringify(wsiReferencePng)})
output = Path(${JSON.stringify(comparisonReport)})

def digest(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()

phase = tifffile.imread(phase_source)
original = np.asarray(Image.open(phase_original))
assert np.array_equal(phase, original), "The documented phase OME conversion changed pixels"
phase_expected_scalar = phase[31:31 + 113, 29:29 + 127]
phase_expected = np.repeat(phase_expected_scalar[..., None], 3, axis=2)
phase_observed = np.asarray(Image.open(phase_loci).convert("RGB"))
Image.fromarray(phase_expected).save(phase_reference)
assert np.array_equal(phase_observed, phase_expected), "Loci phase display differs from the source pixels"

with openslide.OpenSlide(str(wsi_source)) as slide:
    wsi_expected = np.asarray(slide.read_region((37, 53), 0, (127, 113)).convert("RGB"))
wsi_observed = np.asarray(Image.open(wsi_loci).convert("RGB"))
Image.fromarray(wsi_expected).save(wsi_reference)
assert np.array_equal(wsi_observed, wsi_expected), "Loci WSI display differs from direct OpenSlide pixels"

report = {
    "schema": "loci.public-fixture-numerical-comparison/v1",
    "phase": {
        "source_selection_xywh": [29, 31, 127, 113],
        "shape_yxc": list(phase_observed.shape),
        "loci_rgb_sha256": digest(phase_observed),
        "independent_rgb_sha256": digest(phase_expected),
        "maximum_absolute_delta": int(np.abs(phase_observed.astype(np.int16) - phase_expected).max()),
        "ome_conversion_matches_cc0_original": True,
    },
    "wsi": {
        "source_selection_xywh": [37, 53, 127, 113],
        "shape_yxc": list(wsi_observed.shape),
        "loci_rgb_sha256": digest(wsi_observed),
        "independent_rgb_sha256": digest(wsi_expected),
        "maximum_absolute_delta": int(np.abs(wsi_observed.astype(np.int16) - wsi_expected).max()),
        "reference_decoder": "OpenSlide direct read_region RGBA-to-RGB",
        "openslide_version": openslide.__version__,
        "tifffile_version": tifffile.__version__,
    },
}
output.write_text(json.dumps(report, indent=2) + "\n")
`);
  await run(independentPython, [comparisonScript], { timeout: 120_000 });
  const numericalComparison = JSON.parse(await fs.readFile(comparisonReport, "utf8"));
  assert.equal(numericalComparison.phase.maximum_absolute_delta, 0);
  assert.equal(numericalComparison.wsi.maximum_absolute_delta, 0);

  assert.deepEqual(pageErrors, [], "The renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors.");
  assert.deepEqual(networkRequests, [], "The local public-fixture journey made a network request.");
  assert.deepEqual({
    ...buildIdentity,
    executable_sha256: await sha256(executablePath),
    worker_sha256: await sha256(workerPath),
    application_artifact_sha256: await sha256(applicationArtifact),
    ...(packaged ? {} : {
      worker_client_source_sha256: await sha256(workerClientSource),
      worker_module_source_sha256: await sha256(workerModuleSource),
    }),
  }, buildIdentity, "The application or worker artifacts changed during qualification.");
  assert.deepEqual({
    phase: await sha256(phasePath), phase_original: await sha256(phaseOriginalPath),
    kidney: await sha256(kidneyPath), wsi: await sha256(wsiPath),
  }, expectedHashes, "A public source changed during qualification.");

  const report = {
    schema: packaged ? "loci.image-first-public-visual-packaged-qa/v1" :
      "loci.image-first-public-visual-development-qa/v1",
    status: "passed",
    started_at: startedAt,
    elapsed_seconds: (performance.now() - started) / 1000,
    invocation: packaged
      ? `LOCI_PACKAGED_APP=${packagedApp} node tests/image-first-public-visual.qa.mjs`
      : "LOCI_QA_DEV=1 node tests/image-first-public-visual.qa.mjs",
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: {
      phase: { path: phasePath, original_path: phaseOriginalPath, sha256: expectedHashes.phase,
        original_sha256: expectedHashes.phase_original, license: "CC0-1.0" },
      kidney: { path: kidneyPath, sha256: expectedHashes.kidney, license: "CC0-1.0" },
      wsi: { path: wsiPath, sha256: expectedHashes.wsi, license: "CC0-1.0",
        license_source: "OpenSlide test-data index" },
      provenance: publicProvenance,
    },
    assertions: {
      primary_action_identity_stable_during_options_reveal: true,
      collapsed_options_inert: true,
      optical_phase_control_keyboard_focusable: true,
      logo_hover_has_no_backplate_or_ring: true,
      logo_press_compresses_mark_only: true,
      optical_phase_pulses_bounded_to_six: true,
      reduced_motion_suppresses_phase_propagation: true,
      empty_workspace_drag_state_resets_on_blur: true,
      theme_and_text_size_geometry: themeGeometry,
      source_identities_bound: true,
      public_phase_wsi_kidney_rendered: true,
      public_readme_workspace_captures: {
        direct_opening: Object.entries(captures).find(([name]) => name.endsWith("readme-direct-opening-phase"))?.[1],
        native_svs_histology: Object.entries(captures).find(([name]) => name.endsWith("readme-native-svs-histology"))?.[1],
        multichannel_kidney: Object.entries(captures).find(([name]) => name.endsWith("readme-multichannel-kidney"))?.[1],
        raw3d_kidney: Object.entries(captures).find(([name]) => name.endsWith("readme-raw3d-kidney"))?.[1],
        raw_phase_annotation: Object.entries(captures).find(([name]) => name.endsWith("readme-phase-raw-annotation"))?.[1],
      },
      illustrative_phase_segmentation: {
        ...phaseSegmentation,
        scope: "visible built-in adaptive method on the public phase fixture",
        interpretation: "illustrative observed output; no accuracy or biological-performance claim",
      },
      independent_pixel_comparison: numericalComparison,
      renderer_page_errors: pageErrors,
      renderer_console_errors: consoleErrors,
      network_requests: networkRequests,
    },
    reference_artifacts: {
      phase_loci_png: { file: path.basename(phaseLociPng), sha256: await sha256(phaseLociPng) },
      phase_reference_png: { file: path.basename(phaseReferencePng), sha256: await sha256(phaseReferencePng) },
      wsi_loci_png: { file: path.basename(wsiLociPng), sha256: await sha256(wsiLociPng) },
      wsi_reference_png: { file: path.basename(wsiReferencePng), sha256: await sha256(wsiReferencePng) },
      comparison_report: { file: path.basename(comparisonReport), sha256: await sha256(comparisonReport) },
      comparison_script: { file: path.basename(comparisonScript), sha256: await sha256(comparisonScript) },
      independent_python_sha256: await sha256(independentPython),
    },
    captures,
    hardware: { platform: os.platform(), release: os.release(), arch: os.arch(),
      cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem() },
    run_root: runRoot,
  };
  await fs.writeFile(path.join(runRoot, "qa-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await capture("failure").catch(() => undefined);
  await fs.writeFile(path.join(runRoot, "qa-failure.json"), `${JSON.stringify({
    schema: "loci.image-first-public-visual-qa-failure/v1",
    error: String(error?.stack ?? error), source: sourceIdentity, build: buildIdentity,
    fixture_sha256: observedHashes, page_errors: pageErrors, console_errors: consoleErrors,
    network_requests: networkRequests, captures,
  }, null, 2)}\n`);
  throw error;
} finally {
  await close();
}
