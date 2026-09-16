import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ??
    path.resolve(import.meta.dirname, "../../.loci/evidence/qa/workbench-refresh"),
);
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(outputRoot, runName);
const screenshotsRoot = path.join(runRoot, "screenshots");
const firstUserData = path.join(runRoot, "user-data-initial");
const reopenUserData = path.join(runRoot, "user-data-reopen");
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const studyPath = path.join(runRoot, "workbench-refresh.loci-study");
const receiptPath = path.join(runRoot, "workbench-refresh-receipt.json");
const failurePath = path.join(runRoot, "workbench-refresh-failure.json");
const packagedAppInput = process.env.LOCI_PACKAGED_APP ?? process.env.LOCI_QA_APP ?? null;

if (
  process.env.LOCI_PACKAGED_APP &&
  process.env.LOCI_QA_APP &&
  process.env.LOCI_PACKAGED_APP !== process.env.LOCI_QA_APP
) {
  throw new Error("LOCI_PACKAGED_APP and its LOCI_QA_APP alias disagree.");
}
if (packagedAppInput && !path.isAbsolute(packagedAppInput)) {
  throw new Error("LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
}
const packagedApp = packagedAppInput ? path.resolve(packagedAppInput) : null;
const packaged = packagedApp !== null;
if (packaged === (process.env.LOCI_QA_DEV === "1")) {
  throw new Error(
    "Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.",
  );
}
if (process.platform !== "darwin") {
  throw new Error("The workbench refresh journey currently qualifies macOS Electron builds.");
}

const executablePath = packaged
  ? path.join(packagedApp, "Contents", "MacOS", "Loci")
  : path.join(
      desktopRoot,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
const workerPath = packaged
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const mainArtifact = packaged
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const independentPython = path.join(projectRoot, "engine", ".venv", "bin", "python");
const fixturePaths = ["alpha", "bravo", "charlie"].map((name) =>
  path.join(fixtureRoot, `order-${name}.ome.tiff`),
);

const startedAt = new Date().toISOString();
const pageErrors = [];
const consoleErrors = [];
const captures = {};
let app;
let page;
let sourceIdentity;
let buildIdentity;
let fixtureIdentity;
let journey = {};

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function capture(name, target = page) {
  const destination = path.join(screenshotsRoot, `${name}.png`);
  const bytes = await target.screenshot({ path: destination });
  assert.ok(bytes.length > 2_000, `${name} did not capture substantive UI evidence.`);
  captures[name] = {
    file: path.relative(runRoot, destination),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
  }
}

async function waitForFile(file, action, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await noUiError(action);
    await page.waitForTimeout(100);
  }
  throw new Error(`${action}: timed out waiting for ${file}`);
}

async function generateFixtures() {
  const generator = path.join(runRoot, "generate_workbench_refresh_fixtures.py");
  await fs.writeFile(
    generator,
    String.raw`from pathlib import Path
import numpy as np
import tifffile

outputs = [Path(value) for value in ${JSON.stringify(fixturePaths)}]
for index, output in enumerate(outputs):
    y, x = np.ogrid[:48, :64]
    channel_0 = (((x * (index + 3) + y * 5 + index * 101) % 4096) * 32).astype(np.uint16)
    channel_1 = (((x * 7 + y * (index + 4) + 700 + index * 131) % 4096) * 32).astype(np.uint16)
    image = np.stack([channel_0, channel_1], axis=0)
    assert int(image.max()) < 65535
    tifffile.imwrite(
        output,
        image,
        ome=True,
        metadata={
            "axes": "CYX",
            "Channel": {"Name": ["DAPI", "GFP"]},
            "PhysicalSizeX": 0.5,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": 0.5,
            "PhysicalSizeYUnit": "µm",
        },
    )
`,
  );
  await run(independentPython, [generator], { timeout: 120_000 });
}

async function launch(userData) {
  const instance = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [desktopRoot]), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const window = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1320, height: 860 });
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await window.locator("main.image-first-empty, main.research-workbench").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return { instance, window };
}

async function installDialogs() {
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Add microscopy or medical images") {
          return { canceled: false, filePaths: values.fixtures };
        }
        if (options?.title === "Open research study") {
          return { canceled: false, filePaths: [values.study] };
        }
        return { canceled: true, filePaths: [] };
      };
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Save research study as") {
          return { canceled: false, filePath: values.study };
        }
        return { canceled: true, filePath: undefined };
      };
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    { fixtures: fixturePaths, study: studyPath },
  );
}

async function closeApp() {
  if (!app) return;
  const closing = app;
  await closing.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = closing.waitForEvent("close", { timeout: 30_000 });
  await closing.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await closed;
  app = undefined;
  page = undefined;
}

async function workerSnapshot() {
  return page.evaluate(() => window.lociResearch.getSnapshot());
}

async function waitForSources(count) {
  await page.waitForFunction(
    async (expected) => (await window.lociResearch.getSnapshot())?.sources.length === expected,
    count,
    { timeout: 120_000 },
  );
  await page.locator(".research-source-item").nth(count - 1).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  await noUiError("loading sources");
  return workerSnapshot();
}

async function waitForActiveSource(sourceId) {
  const button = page.locator(`.research-source-item[data-source-id="${sourceId}"]`);
  await button.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    (id) => {
      const source = document.querySelector(`.research-source-item[data-source-id="${CSS.escape(id)}"]`);
      const viewer = document.querySelector(`[data-viewer-source="${CSS.escape(id)}"]`);
      return source?.getAttribute("aria-current") === "true" &&
        viewer && !viewer.querySelector(".image-view-loading");
    },
    sourceId,
    { timeout: 120_000 },
  );
  await noUiError(`loading source ${sourceId}`);
}

async function uiSourceOrder() {
  return page.locator(".research-source-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-source-id")),
  );
}

async function waitForWorkerOrder(expected) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const snapshot = await workerSnapshot();
    if (snapshot?.sources.map((source) => source.id).join("\0") === expected.join("\0")) {
      return snapshot;
    }
    await noUiError("persisting image order");
    await page.waitForTimeout(100);
  }
  throw new Error(`Worker snapshot did not retain image order ${expected.join(", ")}.`);
}

async function realPointerDrag(sourceId, targetId) {
  const handle = page.locator(
    `.research-source-item[data-source-id="${sourceId}"] .research-source-drag-handle`,
  );
  const target = page.locator(`.research-source-item[data-source-id="${targetId}"]`);
  const [handleBox, targetBox] = await Promise.all([handle.boundingBox(), target.boundingBox()]);
  assert.ok(handleBox && targetBox, "The image rows did not expose pointer-drag geometry.");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "left" });
  await page.waitForTimeout(50);
  await page.mouse.move(startX, startY - 15, { steps: 5 });
  await page.mouse.move(startX, targetBox.y + 5, { steps: 15 });
  await page.waitForTimeout(50);
  await page.mouse.up({ button: "left" });
}

async function sourcePalettes(sourceIds) {
  return page.evaluate(async (ids) => {
    const records = await Promise.all(ids.map(async (id) => {
      const saved = await window.lociResearch.execute("source_view", { source_id: id });
      return [
        id,
        {
          source_sha256: saved.source_sha256,
          revision: saved.revision,
          colors: saved.state?.channels?.map((channel) => channel.color) ?? null,
        },
      ];
    }));
    return Object.fromEntries(records);
  }, sourceIds);
}

async function waitForPalette(sourceIds, expected) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const palettes = await sourcePalettes(sourceIds);
    if (sourceIds.every((id) =>
      JSON.stringify(palettes[id]?.colors) === JSON.stringify(Array.isArray(expected) ? expected : expected[id]),
    )) return palettes;
    await noUiError("persisting batch channel colours");
    await page.waitForTimeout(100);
  }
  throw new Error(`Saved source palettes did not become ${JSON.stringify(expected)}.`);
}

async function selectAllSources(sourceIds) {
  for (const sourceId of sourceIds) {
    const button = page.locator(`.research-source-item[data-source-id="${sourceId}"]`);
    if (await button.getAttribute("aria-selected") !== "true") {
      await button.click({ modifiers: ["Meta"] });
      await waitForActiveSource(sourceId);
    }
  }
  for (const sourceId of sourceIds) {
    assert.equal(
      await page.locator(`.research-source-item[data-source-id="${sourceId}"]`).getAttribute("aria-selected"),
      "true",
      `Source ${sourceId} was not retained in the multi-selection.`,
    );
  }
}

async function applyCmyPalette(sourceIds, captureName) {
  await page.getByRole("button", { name: /^Apply colors/ }).click();
  const dialog = page.getByRole("dialog", { name: "Apply channel colours" });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  assert.match((await dialog.textContent()) ?? "", new RegExp(`${sourceIds.length} selected`));
  // Opening the dialog flushes pending display autosaves before preview.
  const beforePreview = await sourcePalettes(sourceIds);
  await dialog.getByLabel("Palette preset").selectOption("cmy-subtractive");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await dialog.getByRole("button", { name: "Hide preview", exact: true }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  assert.equal(await dialog.locator("tbody tr").count(), sourceIds.length);
  await capture(`${captureName}-preview`);
  const beforeApply = await sourcePalettes(sourceIds);
  assert.deepEqual(beforeApply, beforePreview,
    "Batch preview mutated a source display document.");
  await dialog.getByRole("button", {
    name: `Apply colour to all ${sourceIds.length} images`,
    exact: true,
  }).click();
  await dialog.waitFor({ state: "hidden", timeout: 120_000 });
  const applied = await waitForPalette(sourceIds, ["#00ffff", "#ffff00"]);
  await capture(`${captureName}-applied`);
  return { beforePreview, afterPreview: beforeApply, applied };
}

async function waitForComparisonPane(index, sourceId) {
  const pane = page.locator(".research-ab-pane").nth(index);
  const viewer = pane.locator(`[data-viewer-source="${sourceId}"]`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    ({ paneIndex, id }) => {
      const candidate = document.querySelectorAll(".research-ab-pane")[paneIndex]
        ?.querySelector(`[data-viewer-source="${CSS.escape(id)}"]`);
      return candidate && Number(candidate.getAttribute("data-cache-bytes")) > 0 &&
        !candidate.querySelector(".image-view-loading");
    },
    { paneIndex: index, id: sourceId },
    { timeout: 120_000 },
  );
  await noUiError(`loading comparison pane ${index === 0 ? "A" : "B"}`);
  return viewer;
}

async function viewerCamera(viewer) {
  const value = await viewer.getAttribute("data-camera");
  assert.ok(value, "A comparison viewer did not expose its camera.");
  return JSON.parse(value);
}

async function waitForCanvasContent(viewer, pane) {
  const canvas = viewer.getByLabel("Source image and bound annotations", { exact: true });
  await canvas.waitFor({ state: "visible", timeout: 120_000 });
  const deadline = performance.now() + 30_000;
  let latest = null;
  while (performance.now() < deadline) {
    latest = await canvas.evaluate((element) => {
      const context = element.getContext("2d");
      if (!context || element.width < 1 || element.height < 1) return null;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let bright = 0;
      let nonBackground = 0;
      let sum = 0;
      let sumSquares = 0;
      const levels = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const luminance = (red + green + blue) / 3;
        if (Math.max(red, green, blue) >= 48) bright += 1;
        if (Math.max(Math.abs(red - 21), Math.abs(green - 21), Math.abs(blue - 21)) > 8)
          nonBackground += 1;
        levels.add(Math.round(luminance));
        sum += luminance;
        sumSquares += luminance * luminance;
      }
      const count = pixels.length / 4;
      const mean = sum / count;
      return {
        width: element.width,
        height: element.height,
        bright_pixels: bright,
        non_background_pixels: nonBackground,
        luminance_levels: levels.size,
        luminance_standard_deviation: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
      };
    });
    if (latest && latest.bright_pixels > 500 && latest.non_background_pixels > 1_000 &&
        latest.luminance_levels >= 8 && latest.luminance_standard_deviation > 3)
      return latest;
    await noUiError(`waiting for substantive ${pane} canvas pixels`);
    await page.waitForTimeout(50);
  }
  throw new Error(`${pane} canvas did not contain a visible gradient: ${JSON.stringify(latest)}.`);
}

function camerasEqual(left, right, tolerance = 1e-8) {
  return ["x", "y", "scale"].every((key) =>
    Math.abs(left[key] - right[key]) <= tolerance,
  );
}

async function waitForLinkedCameras(viewerA, viewerB, changedFrom, change) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const [cameraA, cameraB] = await Promise.all([
      viewerCamera(viewerA),
      viewerCamera(viewerB),
    ]);
    const changed = change === "zoom"
      ? Math.abs(cameraA.scale - changedFrom.scale) > 1e-6
      : Math.hypot(cameraA.x - changedFrom.x, cameraA.y - changedFrom.y) > 1e-6;
    if (changed && camerasEqual(cameraA, cameraB)) return { cameraA, cameraB };
    await noUiError(`linking comparison ${change}`);
    await page.waitForTimeout(50);
  }
  throw new Error(`Pane B did not follow the real pane A ${change} gesture.`);
}

try {
  await Promise.all([
    fs.mkdir(screenshotsRoot, { recursive: true }),
    fs.mkdir(firstUserData, { recursive: true }),
    fs.mkdir(reopenUserData, { recursive: true }),
    fs.mkdir(fixtureRoot, { recursive: true }),
    fs.access(executablePath),
    fs.access(workerPath),
    fs.access(mainArtifact),
    fs.access(independentPython),
  ]);
  await generateFixtures();

  const git = async (...args) =>
    (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = {
    head: await git("rev-parse", "HEAD"),
    head_tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"),
    harness_sha256: await sha256(import.meta.filename),
    workbench_sha256: await sha256(
      path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx"),
    ),
    workspace_records_sha256: await sha256(
      path.join(projectRoot, "engine", "src", "loci_engine", "research_workspace_records.py"),
    ),
  };
  buildIdentity = {
    mode: packaged ? "packaged" : "development",
    app_path: packagedApp,
    executable_path: executablePath,
    executable_sha256: await sha256(executablePath),
    main_artifact_path: mainArtifact,
    main_artifact_sha256: await sha256(mainArtifact),
    worker_path: workerPath,
    worker_sha256: await sha256(workerPath),
    worker_command: packaged
      ? { executable: workerPath, args: [] }
      : { executable: workerPath, args: ["-m", "loci_engine.worker"] },
  };
  fixtureIdentity = Object.fromEntries(await Promise.all(fixturePaths.map(async (fixture) => [
    path.basename(fixture),
    {
      path: fixture,
      sha256: await sha256(fixture),
      dimensions_cyx: [2, 48, 64],
      channel_names: ["DAPI", "GFP"],
      synthetic_non_biological: true,
    },
  ])));

  ({ instance: app, window: page } = await launch(firstUserData));
  await installDialogs();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const opened = await waitForSources(3);
  for (const source of opened.sources) {
    const fixture = fixtureIdentity[source.name];
    assert.ok(fixture, `Imported unexpected source ${source.name}.`);
    assert.equal(source.sha256, fixture.sha256, `${source.name} changed during import.`);
  }
  const initialOrder = opened.sources.map((source) => source.id);
  const preservedSourceId = initialOrder[1];
  await page.locator(`.research-source-item[data-source-id="${preservedSourceId}"]`).click();
  await waitForActiveSource(preservedSourceId);

  const movedSourceId = initialOrder.at(-1);
  await realPointerDrag(movedSourceId, initialOrder[0]);
  const expectedOrder = [movedSourceId, ...initialOrder.slice(0, -1)];
  const refreshed = await waitForWorkerOrder(expectedOrder);
  assert.deepEqual(await uiSourceOrder(), expectedOrder,
    "The image list snapped back after the worker snapshot refresh.");
  const preservedButton = page.locator(
    `.research-source-item[data-source-id="${preservedSourceId}"]`,
  );
  assert.equal(await preservedButton.getAttribute("aria-selected"), "true");
  assert.equal(await preservedButton.getAttribute("aria-current"), "true");
  await capture("01-drag-worker-refresh");
  journey.order = {
    initial: initialOrder,
    after_pointer_drag: expectedOrder,
    worker_refresh: refreshed.sources.map((source) => source.id),
    preserved_selection_source_id: preservedSourceId,
    workspace_revision: refreshed.workspace?.revision,
  };

  await selectAllSources(expectedOrder);
  const firstColors = await applyCmyPalette(expectedOrder, "02-batch-colours");
  await page.getByRole("button", { name: "Undo colors", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /Restored previous colors for 3 image/ }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  const restored = await waitForPalette(expectedOrder, Object.fromEntries(expectedOrder.map((id) => [id, firstColors.beforePreview[id].colors])));
  await capture("03-batch-colours-restored");
  const secondColors = await applyCmyPalette(expectedOrder, "04-batch-colours-roundtrip");
  journey.batch_colors = {
    preview_non_mutating: true,
    first_applied: firstColors.applied,
    restored,
    reapplied: secondColors.applied,
  };

  const palettesBeforeComparison = await sourcePalettes(expectedOrder);
  const comparisonSourceA = expectedOrder[0];
  const comparisonSourceB = expectedOrder[1];
  const sourceARecord = refreshed.sources.find((source) => source.id === comparisonSourceA);
  const sourceBRecord = refreshed.sources.find((source) => source.id === comparisonSourceB);
  assert.ok(sourceARecord && sourceBRecord, "Comparison sources were absent from the worker snapshot.");
  assert.notEqual(sourceARecord.id, sourceBRecord.id);
  assert.notEqual(sourceARecord.sha256, sourceBRecord.sha256);
  assert.deepEqual(sourceARecord.metadata.dimensions, sourceBRecord.metadata.dimensions,
    "The distinct-source link guard was not tested with matching image geometry.");

  await page.getByRole("button", { name: "Compare A/B", exact: true }).click();
  const comparisonToolbar = page.getByLabel("A/B image comparison toolbar", { exact: true });
  await comparisonToolbar.waitFor({ state: "visible", timeout: 30_000 });
  const sourceASelect = page.getByLabel("Pinned Source A", { exact: true });
  const sourceBSelect = page.getByLabel("Pinned Source B", { exact: true });
  await sourceASelect.selectOption(comparisonSourceA);
  await sourceBSelect.selectOption(comparisonSourceB);
  assert.equal(await sourceASelect.inputValue(), comparisonSourceA);
  assert.equal(await sourceBSelect.inputValue(), comparisonSourceB);
  let viewerA = await waitForComparisonPane(0, comparisonSourceA);
  let viewerB = await waitForComparisonPane(1, comparisonSourceB);
  const linkPanZoom = page.getByLabel("Link pan and zoom", { exact: true });
  assert.equal(await linkPanZoom.isDisabled(), true,
    "Matching dimensions incorrectly enabled pan/zoom linking for distinct source identities.");
  assert.equal(await linkPanZoom.isChecked(), false);
  await page.getByText(/Link pan\/zoom \(No verified transform\)/).waitFor();

  const channelA = page.getByLabel("Pane A channel view", { exact: true });
  const channelB = page.getByLabel("Pane B channel view", { exact: true });
  await channelA.selectOption("all");
  await channelB.selectOption("all");
  assert.equal(await channelA.inputValue(), "all");
  assert.equal(await channelB.inputValue(), "all");
  await channelA.selectOption("0");
  assert.equal(await channelA.inputValue(), "0");
  assert.equal(await channelB.inputValue(), "all",
    "Changing pane A channel visibility leaked into pane B.");
  await page.getByRole("button", { name: "Match display (A → B)", exact: true }).click();
  await page.getByText(
    "Display settings matched (A → B). Raw pixel values remain unchanged.",
    { exact: true },
  ).waitFor();
  assert.equal(await channelB.inputValue(), "0",
    "Match display did not copy pane A channel visibility to pane B.");

  await sourceBSelect.selectOption(comparisonSourceA);
  assert.equal(await sourceBSelect.inputValue(), comparisonSourceA);
  viewerA = await waitForComparisonPane(0, comparisonSourceA);
  viewerB = await waitForComparisonPane(1, comparisonSourceA);
  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[aria-label="Link pan and zoom"]');
      return input instanceof HTMLInputElement && !input.disabled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await linkPanZoom.check();
  assert.equal(await linkPanZoom.isChecked(), true);
  const linkedInitial = await viewerCamera(viewerA);
  const linkedPixelsBefore = {
    pane_a: await waitForCanvasContent(viewerA, "Pane A before linked gestures"),
    pane_b: await waitForCanvasContent(viewerB, "Pane B before linked gestures"),
  };
  const viewerABox = await viewerA.boundingBox();
  assert.ok(viewerABox, "Pane A did not expose pointer geometry.");
  const centerX = viewerABox.x + viewerABox.width / 2;
  const centerY = viewerABox.y + viewerABox.height / 2;
  const centerTarget = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target?.getAttribute("aria-label") ?? target?.tagName.toLowerCase() ?? null;
  }, { x: centerX, y: centerY });
  assert.equal(centerTarget, "Source image and bound annotations",
    `Pane A center was obstructed by ${centerTarget}.`);
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -160);
  const linkedAfterWheel = await waitForLinkedCameras(
    viewerA, viewerB, linkedInitial, "zoom",
  );
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(centerX + 36, centerY + 24, { steps: 8 });
  await page.mouse.up({ button: "left" });
  const linkedAfterPan = await waitForLinkedCameras(
    viewerA, viewerB, linkedAfterWheel.cameraA, "pan",
  );
  const linkedPixelsAfter = {
    pane_a: await waitForCanvasContent(viewerA, "Pane A after linked gestures"),
    pane_b: await waitForCanvasContent(viewerB, "Pane B after linked gestures"),
  };
  await capture("05-ab-visible-source-bound-linking", page.locator(".research-ab-comparison"));

  await page.getByRole("button", { name: "Exit A/B", exact: true }).click();
  await comparisonToolbar.waitFor({ state: "hidden", timeout: 30_000 });
  const palettesAfterComparison = await sourcePalettes(expectedOrder);
  assert.deepEqual(palettesAfterComparison, palettesBeforeComparison,
    "Temporary A/B display controls changed saved source palettes.");
  journey.ab_comparison = {
    distinct_sources: {
      source_a: { id: sourceARecord.id, sha256: sourceARecord.sha256 },
      source_b: { id: sourceBRecord.id, sha256: sourceBRecord.sha256 },
      matching_dimensions: sourceARecord.metadata.dimensions,
      link_disabled_without_verified_transform: true,
      pane_a_channel_view: "0",
      pane_b_unchanged_before_match: "all",
      pane_b_after_match: "0",
    },
    exact_source_link: {
      source_id: comparisonSourceA,
      initial_camera: linkedInitial,
      after_real_wheel: linkedAfterWheel,
      after_real_pointer_pan: linkedAfterPan,
      canvas_pixels_before_gestures: linkedPixelsBefore,
      canvas_pixels_after_gestures: linkedPixelsAfter,
    },
    saved_palettes_before: palettesBeforeComparison,
    saved_palettes_after: palettesAfterComparison,
  };

  const resize = page.getByRole("separator", { name: "Resize tools panel" });
  const widthBefore = Number(await resize.getAttribute("aria-valuenow"));
  await resize.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(Number(await resize.getAttribute("aria-valuenow")), widthBefore + 16);
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 48, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const resizedWidth = Number(await resize.getAttribute("aria-valuenow"));
  assert.ok(resizedWidth > widthBefore + 50, "Dragging the tools divider did not widen the panel");
  const storedWidth = await page.evaluate(() => Number(localStorage.getItem("loci.inspector-width.v1")));
  assert.ok(Math.abs(storedWidth - resizedWidth) < 1);
  const panelGeometry = await page.locator(".research-inspector").evaluate((element) => ({
    width: element.getBoundingClientRect().width, overflow: element.scrollWidth - element.clientWidth,
  }));
  assert.ok(Math.abs(panelGeometry.width - resizedWidth) < 1 && panelGeometry.overflow <= 1);
  journey.tools_panel = { widthBefore, resizedWidth, storedWidth, panelGeometry };

  await page.getByRole("button", { name: "Save study", exact: true }).click();
  await waitForFile(path.join(studyPath, "study.sqlite3"), "Save as study");
  await page.locator("main.research-workbench").waitFor({ state: "visible", timeout: 120_000 });
  assert.equal(await page.locator("main.research-workbench").getAttribute("inert"), null,
    "The workspace remained locked after Save as study.");
  await noUiError("Save as study");
  await capture("06-saved-as-study");
  await closeApp();

  ({ instance: app, window: page } = await launch(reopenUserData));
  await installDialogs();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await waitForSources(3);
  const reopenedOrder = reopened.sources.map((source) => source.id);
  assert.deepEqual(reopenedOrder, expectedOrder,
    "Save as and explicit reopen did not retain the pointer-drag image order.");
  for (const source of reopened.sources) {
    const fixture = fixtureIdentity[source.name];
    assert.equal(source.sha256, fixture?.sha256, `${source.name} lost its source binding on reopen.`);
  }
  const reopenedPalettes = await waitForPalette(expectedOrder, ["#00ffff", "#ffff00"]);
  await capture("07-explicit-reopen");
  journey.order.reopened = reopenedOrder;
  journey.batch_colors.reopened = reopenedPalettes;
  journey.study = {
    path: studyPath,
    database_sha256: await sha256(path.join(studyPath, "study.sqlite3")),
  };

  assert.deepEqual(pageErrors, [], "The renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors.");
  const finalBuildIdentity = {
    executable_sha256: await sha256(executablePath),
    main_artifact_sha256: await sha256(mainArtifact),
    worker_sha256: await sha256(workerPath),
  };
  assert.deepEqual(finalBuildIdentity, {
    executable_sha256: buildIdentity.executable_sha256,
    main_artifact_sha256: buildIdentity.main_artifact_sha256,
    worker_sha256: buildIdentity.worker_sha256,
  }, "The application or worker changed during qualification.");
  for (const fixture of Object.values(fixtureIdentity)) {
    assert.equal(await sha256(fixture.path), fixture.sha256,
      `Synthetic source changed during qualification: ${fixture.path}`);
  }

  const receipt = {
    schema: packaged
      ? "loci.workbench-refresh-packaged-qa/v1"
      : "loci.workbench-refresh-development-qa/v1",
    status: "passed",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    invocation: packaged
      ? `LOCI_PACKAGED_APP=${packagedApp} node tests/workbench-refresh.qa.mjs`
      : "LOCI_QA_DEV=1 node tests/workbench-refresh.qa.mjs",
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: fixtureIdentity,
    assertions: {
      real_pointer_drag_persisted_through_worker_refresh: true,
      unrelated_selected_image_remained_selected_and_active: true,
      image_order_survived_save_as_and_explicit_reopen: true,
      batch_preview_was_non_mutating: true,
      batch_apply_and_undo_restored_prior_palettes: true,
      reapplied_palettes_survived_save_as_and_reopen: true,
      distinct_source_geometry_did_not_enable_camera_linking: true,
      comparison_channel_state_remained_source_bound_until_match: true,
      match_display_copied_a_to_b_without_persistence: true,
      exact_source_real_wheel_and_pan_linked_b_to_a: true,
      source_bytes_and_fingerprints_unchanged: true,
    },
    journey,
    screenshots: captures,
    renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  };
  await closeApp();
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${receiptPath}\n`);
} catch (error) {
  let failureScreenshot;
  if (page) {
    try {
      await capture("99-failure");
      failureScreenshot = captures["99-failure"];
    } catch {}
  }
  let closeError;
  try {
    await closeApp();
  } catch (caught) {
    closeError = caught instanceof Error ? caught.message : String(caught);
  }
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(failurePath, `${JSON.stringify({
    schema: "loci.workbench-refresh-qa-failure/v1",
    status: "failed",
    started_at: startedAt,
    failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    close_error: closeError,
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: fixtureIdentity,
    journey,
    screenshot: failureScreenshot,
    renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  }, null, 2)}\n`);
  throw error;
}
