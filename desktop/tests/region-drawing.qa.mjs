import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ??
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/region-drawing"));
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(outputRoot, runName);
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const fixturePath = path.join(fixtureRoot, "synthetic-anisotropic-regions.ome.tiff");
const studyPath = path.join(runRoot, "region-drawing.loci-study");
const initialUserData = path.join(runRoot, "user-data-initial");
const reopenUserData = path.join(runRoot, "user-data-reopen");
const screenshotsRoot = path.join(runRoot, "screenshots");
const receiptPath = path.join(runRoot, "region-drawing-receipt.json");
const failurePath = path.join(runRoot, "region-drawing-failure.json");
const packagedAppInput = process.env.LOCI_PACKAGED_APP ?? process.env.LOCI_QA_APP ?? null;

if (process.env.LOCI_PACKAGED_APP && process.env.LOCI_QA_APP &&
    process.env.LOCI_PACKAGED_APP !== process.env.LOCI_QA_APP)
  throw new Error("LOCI_PACKAGED_APP and its LOCI_QA_APP alias disagree.");
if (packagedAppInput && !path.isAbsolute(packagedAppInput))
  throw new Error("LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
const packagedApp = packagedAppInput ? path.resolve(packagedAppInput) : null;
const packaged = packagedApp !== null;
if (packaged === (process.env.LOCI_QA_DEV === "1"))
  throw new Error("Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.");
if (process.platform !== "darwin")
  throw new Error("The region-drawing journey currently qualifies macOS Electron builds.");

const executablePath = packaged
  ? path.join(packagedApp, "Contents", "MacOS", "Loci")
  : path.join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const workerPath = packaged
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const mainArtifact = packaged
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const independentPython = path.join(projectRoot, "engine", ".venv", "bin", "python");

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

async function generateFixture() {
  const generator = path.join(runRoot, "generate_region_fixture.py");
  await fs.writeFile(generator, String.raw`from pathlib import Path
import numpy as np
import tifffile

output = Path(${JSON.stringify(fixturePath)})
height, width = 240, 320
yy, xx = np.ogrid[:height, :width]
image = np.empty((height, width, 3), dtype=np.uint8)
image[..., 0] = (xx * 255 // (width - 1)).astype(np.uint8)
image[..., 1] = (yy * 255 // (height - 1)).astype(np.uint8)
image[..., 2] = (((xx // 16 + yy // 16) % 2) * 80 + 70).astype(np.uint8)
tifffile.imwrite(output, image, ome=True, photometric="rgb", metadata={
    "axes": "YXS",
    "PhysicalSizeX": 0.5,
    "PhysicalSizeXUnit": "µm",
    "PhysicalSizeY": 0.8,
    "PhysicalSizeYUnit": "µm",
})
with tifffile.TiffFile(output) as tif:
    assert tif.series[0].axes == "YXS"
    assert tif.series[0].shape == (240, 320, 3)
`);
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
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1320, height: 900 });
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await window.locator("main.image-first-empty, main.research-workbench").waitFor({
    state: "visible", timeout: 30_000,
  });
  return { instance, window };
}

async function installDialogs() {
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images")
        return { canceled: false, filePaths: [values.fixture] };
      if (options?.title === "Open research study")
        return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Save research study as")
        return { canceled: false, filePath: values.study };
      return { canceled: true, filePath: undefined };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { fixture: fixturePath, study: studyPath });
}

async function closeApp() {
  if (!app) return;
  const closing = app;
  await closing.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = closing.waitForEvent("close", { timeout: 30_000 });
  await closing.evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 0));
  await closed;
  app = undefined;
  page = undefined;
}

async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
}

async function waitForFile(file, action) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    try {
      if ((await fs.stat(file)).size > 0) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await noUiError(action);
    await page.waitForTimeout(100);
  }
  throw new Error(`${action}: timed out waiting for ${file}`);
}

async function waitForSource() {
  await page.locator(".research-source-item").waitFor({ state: "visible", timeout: 120_000 });
  let snapshot;
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    if (snapshot?.sources.length === 1) break;
    await noUiError("opening the synthetic source");
    await page.waitForTimeout(100);
  }
  assert.equal(snapshot?.sources.length, 1);
  const source = snapshot.sources[0];
  const viewer = page.locator(`[data-viewer-source="${source.id}"]`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction((id) => {
    const element = document.querySelector(`[data-viewer-source="${CSS.escape(id)}"]`);
    return element && Number(element.getAttribute("data-cache-bytes")) > 0 &&
      !element.querySelector(".image-view-loading");
  }, source.id, { timeout: 120_000 });
  await noUiError("loading the synthetic source");
  return { source, viewer };
}

async function annotationReceipt(sourceId) {
  return page.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), sourceId);
}

async function waitForAnnotationCount(sourceId, count) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const receipt = await annotationReceipt(sourceId);
    if (receipt.annotations.length === count) return receipt;
    await noUiError("saving source regions");
    await page.waitForTimeout(100);
  }
  throw new Error(`Annotation history did not reach ${count} saved regions.`);
}

async function screenPoints(viewer, sourcePoints) {
  return viewer.evaluate((element, points) => {
    const camera = JSON.parse(element.getAttribute("data-camera"));
    const viewport = element.getBoundingClientRect();
    const source = points.map((point) => ({
      x: viewport.left + viewport.width / 2 + (point.x - camera.x) * camera.scale,
      y: viewport.top + viewport.height / 2 + (point.y - camera.y) * camera.scale * 1.6,
    }));
    const canvas = element.querySelector('canvas[aria-label="Source image and bound annotations"]');
    return source.map((point) => ({ ...point, hit_is_canvas: document.elementFromPoint(point.x, point.y) === canvas }));
  }, sourcePoints);
}

async function clickSourcePoints(viewer, points) {
  const mapped = await screenPoints(viewer, points);
  for (const point of mapped) {
    assert.equal(point.hit_is_canvas, true, `A region point was obstructed at ${JSON.stringify(point)}.`);
    await page.mouse.click(point.x, point.y, { button: "left" });
  }
  return mapped;
}

async function dragSourcePath(viewer, points, steps = 1) {
  const mapped = await screenPoints(viewer, points);
  assert.ok(mapped.every((point) => point.hit_is_canvas), "A drag path was obstructed by viewport chrome.");
  await page.mouse.move(mapped[0].x, mapped[0].y);
  await page.mouse.down({ button: "left" });
  for (const point of mapped.slice(1)) await page.mouse.move(point.x, point.y, { steps });
  await page.mouse.up({ button: "left" });
  return mapped;
}

async function saveDraft(label, expectedCount) {
  await page.getByLabel("Annotation label", { exact: true }).fill(label);
  const save = page.getByRole("button", { name: "Save annotation", exact: true });
  await assert.doesNotReject(() => save.waitFor({ state: "visible" }));
  assert.equal(await save.isEnabled(), true, `${label} did not produce a savable region.`);
  await save.click();
  await page.getByText(`${expectedCount} saved`, { exact: true }).waitFor({ timeout: 120_000 });
}

function closeTo(actual, expected, tolerance = 0.06) {
  return Math.abs(actual - expected) <= tolerance;
}

async function capture(name) {
  const destination = path.join(screenshotsRoot, `${name}.png`);
  const bytes = await page.screenshot({ path: destination });
  assert.ok(bytes.length > 2_000, `${name} did not capture substantive UI evidence.`);
  captures[name] = { file: path.relative(runRoot, destination), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

try {
  await Promise.all([
    fs.mkdir(fixtureRoot, { recursive: true }), fs.mkdir(initialUserData, { recursive: true }),
    fs.mkdir(reopenUserData, { recursive: true }), fs.mkdir(screenshotsRoot, { recursive: true }),
    fs.access(executablePath), fs.access(workerPath), fs.access(mainArtifact), fs.access(independentPython),
  ]);
  await generateFixture();
  const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = {
    head: await git("rev-parse", "HEAD"), head_tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"), harness_sha256: await sha256(import.meta.filename),
    viewport_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "ImageViewport.tsx")),
    panel_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "SourceAnnotationPanel.tsx")),
    workbench_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx")),
  };
  buildIdentity = {
    mode: packaged ? "packaged" : "development", app_path: packagedApp,
    executable_sha256: await sha256(executablePath), main_artifact_sha256: await sha256(mainArtifact),
    worker_sha256: await sha256(workerPath),
  };
  fixtureIdentity = { path: fixturePath, sha256: await sha256(fixturePath), axes: "YXS",
    dimensions_yxs: [240, 320, 3], physical_calibration: { x: 0.5, y: 0.8, unit: "µm" },
    synthetic_non_biological: true, contains_protected_data: false };

  ({ instance: app, window: page } = await launch(initialUserData));
  await installDialogs();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const opened = await waitForSource();
  assert.equal(opened.source.sha256, fixtureIdentity.sha256);
  assert.deepEqual(opened.source.metadata.physical_calibration,
    { axes: "YX", spacing: [0.8, 0.5], unit: "µm" });
  await selectWorkbenchTool(page, "Annotate");
  await page.getByRole("heading", { name: "Annotate", exact: true }).waitFor();
  const toolGeometry = await page.getByLabel("Annotation tools", { exact: true }).evaluate((element) => {
    const tools = [...element.querySelectorAll("button")].map((button) => {
      const box = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), top: box.top, width: box.width };
    });
    return { tools, horizontalOverflow: element.scrollWidth - element.clientWidth };
  });
  assert.equal(toolGeometry.tools.length, 7);
  assert.ok(toolGeometry.horizontalOverflow <= 1);
  assert.ok(toolGeometry.tools.every((tool) => Math.abs(tool.top - toolGeometry.tools[0].top) <= 1 &&
    Math.abs(tool.width - toolGeometry.tools[0].width) <= 1), "Annotation tools must form an even row at default panel width");

  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  const rectangleInput = [{ x: 35, y: 35 }, { x: 125, y: 105 }];
  const rectangleScreen = await dragSourcePath(opened.viewer, rectangleInput, 6);
  await saveDraft("QA dragged rectangle", 1);
  let saved = await waitForAnnotationCount(opened.source.id, 1);
  const rectangle = saved.annotations[0];
  assert.equal(rectangle.kind, "rectangle");
  assert.equal(rectangle.points.length, 4);
  assert.ok(closeTo(rectangle.points[0].x, 35) && closeTo(rectangle.points[0].y, 35));
  assert.ok(closeTo(rectangle.points[2].x, 125) && closeTo(rectangle.points[2].y, 105));
  assert.deepEqual(rectangle.points.map((point) => [point.x, point.y]), [
    [rectangle.points[0].x, rectangle.points[0].y],
    [rectangle.points[2].x, rectangle.points[0].y],
    [rectangle.points[2].x, rectangle.points[2].y],
    [rectangle.points[0].x, rectangle.points[2].y],
  ]);

  await page.getByRole("button", { name: "Polygon", exact: true }).click();
  const polygonInput = [{ x: 155, y: 30 }, { x: 275, y: 40 }, { x: 265, y: 110 }, { x: 170, y: 125 }];
  const polygonScreen = await clickSourcePoints(opened.viewer, polygonInput);
  await page.mouse.click(polygonScreen[0].x + 6, polygonScreen[0].y + 3, { button: "left" });
  await saveDraft("QA closed polygon", 2);
  saved = await waitForAnnotationCount(opened.source.id, 2);
  const polygon = saved.annotations.find((item) => item.label === "QA closed polygon");
  assert.equal(polygon.kind, "polygon");
  assert.equal(polygon.points.length, polygonInput.length,
    "Clicking the first screen-space handle must close without adding another vertex.");
  polygon.points.forEach((point, index) => {
    assert.ok(closeTo(point.x, polygonInput[index].x) && closeTo(point.y, polygonInput[index].y));
  });

  await page.getByRole("button", { name: "Freehand region", exact: true }).click();
  const freehandInput = [
    { x: 55, y: 135 }, { x: 120, y: 140 }, { x: 145, y: 195 },
    { x: 95, y: 215 }, { x: 45, y: 185 },
  ];
  const freehandScreen = await dragSourcePath(opened.viewer, freehandInput, 5);
  await saveDraft("QA freehand region", 3);
  saved = await waitForAnnotationCount(opened.source.id, 3);
  const freehand = saved.annotations.find((item) => item.label === "QA freehand region");
  assert.equal(freehand.kind, "polygon");
  assert.ok(freehand.points.length >= freehandInput.length,
    "The freehand drag did not retain its sampled path.");
  assert.ok(freehand.area > 0 && freehand.length > 0);
  assert.equal(freehand.z, 0); assert.equal(freehand.t, 0);
  assert.ok(freehand.points.every((point) => point.x >= 0 && point.x <= 320 && point.y >= 0 && point.y <= 240));
  await noUiError("saving rectangle, polygon, and freehand regions");
  await capture("01-saved-regions");

  await fileMenuAction(page, "Save as study…");
  await waitForFile(path.join(studyPath, "study.sqlite3"), "saving the region study");
  const savedAnnotations = saved.annotations;
  journey = {
    source: { id: opened.source.id, sha256: opened.source.sha256, name: opened.source.name },
    pointer_mapping: { rectangle: rectangleScreen, polygon: polygonScreen, freehand: freehandScreen,
      formula: "viewport center + source offset * camera scale; Y also multiplied by 0.8 / 0.5" },
    annotations: savedAnnotations,
    saved_revision: saved.revision,
    tool_geometry: toolGeometry,
  };
  await closeApp();

  ({ instance: app, window: page } = await launch(reopenUserData));
  await installDialogs();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await waitForSource();
  assert.equal(reopened.source.id, opened.source.id);
  assert.equal(reopened.source.sha256, fixtureIdentity.sha256);
  const reopenedReceipt = await waitForAnnotationCount(reopened.source.id, 3);
  assert.deepEqual(reopenedReceipt.annotations, savedAnnotations,
    "Explicit study reopen changed the saved region geometry or provenance.");
  await selectWorkbenchTool(page, "Annotate");
  await page.getByText("3 saved", { exact: true }).waitFor();
  await capture("02-reopened-regions");
  journey.reopen = { source_id: reopened.source.id, source_sha256: reopened.source.sha256,
    annotations: reopenedReceipt.annotations, study_database_sha256: await sha256(path.join(studyPath, "study.sqlite3")) };

  assert.deepEqual(pageErrors, [], "The renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors.");
  assert.equal(await sha256(fixturePath), fixtureIdentity.sha256, "The synthetic source changed during QA.");
  assert.deepEqual({ executable_sha256: await sha256(executablePath),
    main_artifact_sha256: await sha256(mainArtifact), worker_sha256: await sha256(workerPath) }, {
    executable_sha256: buildIdentity.executable_sha256,
    main_artifact_sha256: buildIdentity.main_artifact_sha256,
    worker_sha256: buildIdentity.worker_sha256,
  }, "The tested app or worker changed during QA.");

  const receipt = {
    schema: packaged ? "loci.region-drawing-packaged-qa/v1" : "loci.region-drawing-development-qa/v1",
    status: "passed", started_at: startedAt, completed_at: new Date().toISOString(),
    invocation: packaged ? `LOCI_PACKAGED_APP=${packagedApp} node tests/region-drawing.qa.mjs`
      : "LOCI_QA_DEV=1 node tests/region-drawing.qa.mjs",
    source: sourceIdentity, build: buildIdentity, fixture: fixtureIdentity,
    assertions: {
      rectangle_drag_saved_closed_four_corner_geometry: true,
      polygon_start_handle_closed_without_extra_vertex: true,
      freehand_drag_saved_bounded_polygon_samples: true,
      exact_source_identity_and_t_z_retained: true,
      save_as_and_explicit_reopen_retained_regions: true,
      source_bytes_and_runtime_identities_unchanged: true,
    },
    journey, screenshots: captures, renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  };
  await closeApp();
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${receiptPath}\n`);
} catch (error) {
  let failureScreenshot;
  if (page) {
    try { await capture("99-failure"); failureScreenshot = captures["99-failure"]; } catch {}
  }
  let closeError;
  try { await closeApp(); } catch (caught) { closeError = caught instanceof Error ? caught.message : String(caught); }
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(failurePath, `${JSON.stringify({
    schema: "loci.region-drawing-qa-failure/v1", status: "failed", started_at: startedAt,
    failed_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined, close_error: closeError,
    source: sourceIdentity, build: buildIdentity, fixture: fixtureIdentity, journey,
    screenshot: failureScreenshot, renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  }, null, 2)}\n`);
  process.stderr.write(`${failurePath}\n`);
  throw error;
}
