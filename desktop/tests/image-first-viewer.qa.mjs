import { checkSettingsAndManual } from "./settings-qa-helpers.mjs";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import {
  measureRafDuring,
  startProcessTreeRssSampler,
} from "./navigation-performance-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const qualificationRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ??
    path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/development-viewer"),
);
const fixtureRoot = path.resolve(
  process.env.LOCI_QA_FIXTURE_ROOT ??
    path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/fixtures"),
);
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(qualificationRoot, runName);
const userData = path.join(runRoot, "user-data");
const screenshots = path.join(runRoot, "screenshots");
const studyPath = path.join(runRoot, "viewer-journey.loci-study");
const annotationPath = path.join(runRoot, "pyramid-source.loci-annotations.json");
const renderedPath = path.join(runRoot, "scalar-current-display.png");
const renderedTiffPath = path.join(runRoot, "scalar-current-display.tiff");
const scalarFixture = path.join(
  fixtureRoot,
  "anisotropic_tczyx_two_objects.ome.tiff",
);
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
const pyramidFixture = path.join(
  runRoot,
  "synthetic-pyramidal-colour-source-with-a-deliberately-long-name-for-header-geometry.tiff",
);
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
const workerClientSource = path.join(desktopRoot, "src", "main", "worker-client.ts");
const workerModuleSource = path.join(projectRoot, "engine", "src", "loci_engine", "worker.py");
const independentPython = path.join(projectRoot, "engine", ".venv", "bin", "python");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    "The image-first viewer development journey currently qualifies Apple-silicon macOS.",
  );
}
await Promise.all([
  fs.mkdir(userData, { recursive: true }),
  fs.mkdir(screenshots, { recursive: true }),
  fs.access(scalarFixture),
  fs.access(executablePath),
  fs.access(workerPath),
  fs.access(mainArtifact),
  fs.access(independentPython),
]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function generatePyramid() {
  const generator = path.join(runRoot, "generate_pyramidal_rgb.py");
  await fs.writeFile(
    generator,
    String.raw`from pathlib import Path
import numpy as np
import tifffile

output = Path(${JSON.stringify(pyramidFixture)})
height, width = 3072, 4096
y, x = np.ogrid[:height, :width]
red = np.broadcast_to(((x * 255) // (width - 1)).astype(np.uint8), (height, width))
green = np.broadcast_to(((y * 255) // (height - 1)).astype(np.uint8), (height, width))
blue = ((((x // 128) + (y // 128)) % 2) * 150 + 50).astype(np.uint8)
image = np.stack([red, green, blue], axis=-1)
with tifffile.TiffWriter(output, bigtiff=True) as tif:
    tif.write(image, photometric="rgb", tile=(256, 256), subifds=2,
              metadata={"axes": "YXS"})
    tif.write(image[::2, ::2], photometric="rgb", tile=(256, 256),
              subfiletype=1, metadata={"axes": "YXS"})
    tif.write(image[::4, ::4], photometric="rgb", tile=(256, 256),
              subfiletype=1, metadata={"axes": "YXS"})
with tifffile.TiffFile(output) as tif:
    assert [level.shape for level in tif.series[0].levels] == [
        (3072, 4096, 3), (1536, 2048, 3), (768, 1024, 3)]
`,
  );
  await run(
    path.join(projectRoot, "engine", ".venv", "bin", "python"),
    [generator],
    { timeout: 120_000 },
  );
}

await generatePyramid();
const fixtureHashes = {
  pyramid: await sha256(pyramidFixture),
  scalar: await sha256(scalarFixture),
};
const git = async (...args) =>
  (await run("git", args, { cwd: projectRoot })).stdout.trim();
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  head_tree: await git("rev-parse", "HEAD^{tree}"),
  status: await git("status", "--porcelain"),
  harness_sha256: await sha256(import.meta.filename),
  workbench_sha256: await sha256(
    path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx"),
  ),
  viewport_sha256: await sha256(
    path.join(desktopRoot, "src", "renderer", "ImageViewport.tsx"),
  ),
  navigation_performance_helper_sha256: await sha256(
    path.join(desktopRoot, "tests", "navigation-performance-qa-helpers.mjs"),
  ),
};
const buildIdentity = {
  mode: packaged ? "packaged-binary" : "python-module:loci_engine.worker",
  executable_sha256: await sha256(executablePath),
  worker_sha256: await sha256(workerPath),
  main_artifact_sha256: await sha256(mainArtifact),
  worker_command: packaged
    ? { executable: workerPath, args: [], cwd: null }
    : {
        executable: workerPath,
        args: ["-m", "loci_engine.worker"],
        cwd: path.join(projectRoot, "engine"),
      },
  ...(packaged ? {} : {
    worker_client_source_sha256: await sha256(workerClientSource),
    worker_module_source_sha256: await sha256(workerModuleSource),
  }),
};

const startedAt = new Date().toISOString();
const journeyStart = performance.now();
const timing = {};
const captures = {};
const pageErrors = [];
const consoleErrors = [];
const processTreeRss = [];
let annotationExportEvidence;
let renderedExportEvidence;
let renderedTiffExportEvidence;
let settingsAndManualEvidence;
let app;
let page;
let rssSampler;

function percentile(values, fraction) {
  assert.ok(values.length > 0, "A percentile requires observations.");
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}

async function capture(name, locator = page) {
  const destination = path.join(screenshots, `${name}.png`);
  const bytes = await locator.screenshot({ path: destination });
  const record = {
    file: path.basename(destination),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  assert.ok(record.bytes > 2_000, `${name} did not capture a substantive UI.`);
  captures[name] = record;
  return record;
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
  await noUiError(action);
  throw new Error(`${action}: timed out waiting for ${file}`);
}

async function launch() {
  const launchStart = performance.now();
  const instance = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [desktopRoot]), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const sampler = await startProcessTreeRssSampler(instance.process().pid, {
    intervalMs: 200,
    workerCommandIncludes: packaged ? workerPath : "-m loci_engine.worker",
  });
  const window = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({
      width: 1230,
      height: 820,
    });
  });
  await window.locator("main.image-first-empty, main.research-workbench").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  timing.cold_launch_ms ??= performance.now() - launchStart;
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { instance, window, sampler };
}

async function installDialogs(mode) {
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Add microscopy or medical images") {
          return values.mode === "cancel"
            ? { canceled: true, filePaths: [] }
            : { canceled: false, filePaths: values.fixtures };
        }
        if (options?.title === "Open research study") {
          return { canceled: false, filePaths: [values.study] };
        }
        if (options?.title === "Import raw source annotations") {
          return { canceled: false, filePaths: [values.annotations] };
        }
        return { canceled: true, filePaths: [] };
      };
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Save research study as") {
          return { canceled: false, filePath: values.study };
        }
        if (options?.title === "Export raw source annotations") {
          return { canceled: false, filePath: values.annotations };
        }
        if (options?.title === "Export rendered source PNG") {
          return { canceled: false, filePath: values.rendered };
        }
        if (options?.title === "Export rendered source TIFF") {
          return { canceled: false, filePath: values.renderedTiff };
        }
        return { canceled: true, filePath: undefined };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    {
      mode,
      fixtures: [pyramidFixture, scalarFixture],
      study: studyPath,
      annotations: annotationPath,
      rendered: renderedPath,
      renderedTiff: renderedTiffPath,
    },
  );
}

async function stopRssSampling() {
  if (!rssSampler) return;
  const activeSampler = rssSampler;
  rssSampler = undefined;
  processTreeRss.push({
    launch_index: processTreeRss.length + 1,
    ...await activeSampler.stop(),
  });
}

async function close() {
  if (!app) return;
  let samplingFailure;
  if (rssSampler) {
    try {
      await stopRssSampling();
    } catch (error) {
      samplingFailure = error;
    }
  }
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  }).catch(() => undefined);
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await closed;
  app = undefined;
  page = undefined;
  if (samplingFailure) throw samplingFailure;
}

async function selectTool(group, value) {
  await selectWorkbenchTool(page, value);
}

async function waitForViewer(sourceName) {
  const viewer = page.getByLabel(`Image viewer: ${sourceName}`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    (name) => {
      const element = [...document.querySelectorAll(".image-viewport")].find(
        (item) => item.getAttribute("aria-label") === `Image viewer: ${name}`,
      );
      return element && Number(element.getAttribute("data-cache-bytes")) > 0 &&
        !element.querySelector(".image-view-loading");
    },
    sourceName,
    { timeout: 120_000 },
  );
  await noUiError(`loading ${sourceName}`);
  return viewer;
}

try {
  ({ instance: app, window: page, sampler: rssSampler } = await launch());
  await installDialogs("cancel");
  const empty = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.equal(empty.state.status, "empty");
  assert.equal(empty.snapshot, null);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const afterCancel = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.equal(afterCancel.state.status, "empty");
  assert.equal(afterCancel.snapshot, null);
  const sessionEntries = await fs.readdir(path.join(userData, "sessions")).catch(() => []);
  assert.deepEqual(sessionEntries, [], "Cancelling the first picker allocated a managed study.");

  await installDialogs("open");
  const importStart = performance.now();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  const pyramidName = path.basename(pyramidFixture);
  const scalarName = path.basename(scalarFixture);
  const pyramidButton = page.locator(".research-sources").getByRole("button", {
    name: new RegExp(`^${pyramidName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
  const scalarButton = page.locator(".research-sources").getByRole("button", {
    name: new RegExp(`^${scalarName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
  await Promise.all([
    pyramidButton.waitFor({ state: "visible", timeout: 120_000 }),
    scalarButton.waitFor({ state: "visible", timeout: 120_000 }),
  ]);
  const pyramidViewer = await waitForViewer(pyramidName);
  timing.import_to_full_fit_ms = performance.now() - importStart;

  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const pyramidSource = snapshot.sources.find((item) => item.name === pyramidName);
  const scalarSource = snapshot.sources.find((item) => item.name === scalarName);
  assert.ok(pyramidSource && scalarSource, "Imported sources are absent from the managed snapshot.");
  assert.equal(pyramidSource.sha256, fixtureHashes.pyramid);
  assert.equal(scalarSource.sha256, fixtureHashes.scalar);
  assert.equal(await pyramidViewer.getAttribute("data-viewer-source"), pyramidSource.id);

  const initialLevel = Number(await pyramidViewer.getAttribute("data-auto-level"));
  assert.ok(initialLevel > 0, "Full fit did not select a native pyramid level.");
  captures.full_fit = await capture("01-full-fit", pyramidViewer);
  const nativeStart = performance.now();
  const cacheBytesBeforeNativeZoom = Number(await pyramidViewer.getAttribute("data-cache-bytes"));
  await pyramidViewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  await page.waitForFunction(
    ({ name, previousBytes }) => {
      const viewer = document.querySelector(`[aria-label="Image viewer: ${CSS.escape(name)}"]`);
      return viewer?.getAttribute("data-auto-level") === "0" &&
        Number(viewer.getAttribute("data-cache-bytes")) > previousBytes &&
        !viewer.querySelector(".image-view-loading");
    },
    { name: pyramidName, previousBytes: cacheBytesBeforeNativeZoom },
    { timeout: 120_000 },
  );
  timing.native_zoom_ready_ms = performance.now() - nativeStart;
  assert.ok(timing.native_zoom_ready_ms <= 3_000,
    `First native-detail view exceeded 3 seconds: ${timing.native_zoom_ready_ms} ms`);
  captures.native_zoom = await capture("02-native-zoom", pyramidViewer);
  assert.notEqual(captures.native_zoom.sha256, captures.full_fit.sha256);

  const activeLabel = page.getByLabel("Active image");
  await activeLabel.waitFor({ state: "visible" });
  const labelGeometry = await activeLabel.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      text: element.textContent,
      left: box.left,
      right: box.right,
      width: box.width,
      client_width: element.clientWidth,
      scroll_width: element.scrollWidth,
      viewport_width: innerWidth,
      device_pixel_ratio: devicePixelRatio,
      white_space: getComputedStyle(element).whiteSpace,
    };
  });
  assert.equal(labelGeometry.text, pyramidName);
  assert.ok(labelGeometry.right <= labelGeometry.viewport_width);
  assert.ok(labelGeometry.scroll_width <= labelGeometry.client_width + 1,
    "The active image filename is clipped or ellipsized.");

  await selectTool("Annotate", "Annotate");
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await page.getByLabel("Annotation label").fill("QA rectangle");
  const canvas = pyramidViewer.getByLabel("Source image and bound annotations");
  await canvas.click({ position: { x: 270, y: 235 } });
  await canvas.click({ position: { x: 480, y: 390 } });
  await page.getByRole("button", { name: "Save annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo annotation", exact: true }).click();
  await page.getByText("0 saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Redo annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor();
  captures.annotation = await capture("03-annotation-redo", pyramidViewer);

  await page.getByText("Import & export annotations", { exact: true }).click();
  await page.getByRole("button", { name: "Export annotations", exact: true }).click();
  await waitForFile(annotationPath, "Export source annotations");
  await page.getByText(`Exported 1 annotations to ${path.basename(annotationPath)}.`).waitFor();
  const annotationText = await fs.readFile(annotationPath, "utf8");
  const annotationPackage = JSON.parse(annotationText);
  assert.equal(annotationPackage.schema, "loci.source-annotation-interchange/v1");
  assert.equal(annotationPackage.annotation_count, 1);
  assert.equal(annotationPackage.source.sha256, pyramidSource.sha256);
  assert.equal(annotationPackage.annotations[0].label, "QA rectangle");
  assert.ok(!annotationText.includes(runRoot) && !annotationText.includes(pyramidFixture),
    "The raw annotation package disclosed a private local path.");
  annotationExportEvidence = {
    file: path.basename(annotationPath),
    sha256: await sha256(annotationPath),
    bytes: Buffer.byteLength(annotationText),
    annotation_count: annotationPackage.annotation_count,
    source_sha256: annotationPackage.source.sha256,
  };

  await page.getByRole("button", { name: "Undo annotation", exact: true }).click();
  await page.getByText("0 saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Import annotations", exact: true }).click();
  await page.getByText("Annotations imported. Undo is available.", { exact: true }).waitFor();
  await page.getByText("1 saved", { exact: true }).waitFor();

  await scalarButton.click();
  const scalarViewer = await waitForViewer(scalarName);
  await selectTool("View", "Display");
  await page.getByText(/Channel 1|synthetic-intensity/).first().click();
  const channelLow = page.getByLabel("Channel 1 low");
  await channelLow.fill("7");
  await channelLow.press("Enter");
  await scalarViewer.locator(".image-view-tools").getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(550);
  const scalarCamera = await scalarViewer.getAttribute("data-camera");

  const switchDurations = [];
  for (let index = 0; index < 4; index += 1) {
    let started = performance.now();
    await pyramidButton.click();
    await waitForViewer(pyramidName);
    switchDurations.push(performance.now() - started);
    started = performance.now();
    await scalarButton.click();
    await waitForViewer(scalarName);
    switchDurations.push(performance.now() - started);
  }
  assert.equal(await scalarViewer.getAttribute("data-camera"), scalarCamera,
    "The scalar source camera was not restored after source switching.");
  await selectTool("View", "Display");
  await page.getByText(/Channel 1|synthetic-intensity/).first().click();
  assert.equal(await page.getByLabel("Channel 1 low").inputValue(), "7");
  timing.source_switch_ms = {
    observations: switchDurations,
    p95: percentile(switchDurations, 0.95),
  };

  await page.getByText("Export rendered image", { exact: true }).click();
  await page.getByRole("button", { name: "Export PNG…", exact: true }).click();
  await waitForFile(renderedPath, "Export rendered source PNG");
  await page.getByText(`Saved 40 × 32 · ${path.basename(renderedPath)}`, { exact: true }).waitFor();
  const renderedBytes = await fs.readFile(renderedPath);
  assert.deepEqual([...renderedBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(renderedBytes.readUInt32BE(16), 40);
  assert.equal(renderedBytes.readUInt32BE(20), 32);
  const renderedText = renderedBytes.toString("latin1");
  assert.ok(renderedText.includes("Loci rendering provenance"));
  assert.ok(renderedText.includes(scalarSource.sha256));
  assert.ok(renderedText.includes('"low":7'));
  assert.ok(renderedText.includes("display RGB; not original-value quantitative data"));
  assert.ok(renderedText.includes("iCCP"));
  assert.ok(!renderedText.includes(runRoot) && !renderedText.includes(scalarFixture),
    "The rendered PNG disclosed a private local path.");
  renderedExportEvidence = {
    file: path.basename(renderedPath),
    sha256: await sha256(renderedPath),
    bytes: renderedBytes.length,
    width: renderedBytes.readUInt32BE(16),
    height: renderedBytes.readUInt32BE(20),
    source_sha256: scalarSource.sha256,
    embedded_srgb_profile: true,
    embedded_path_free_provenance: true,
  };

  await page.getByLabel("Rendered export format").selectOption("tiff");
  assert.equal(await page.getByLabel("Rendered export extent").inputValue(), "whole");
  await page.getByRole("button", { name: "Export TIFF16…", exact: true }).click();
  await waitForFile(renderedTiffPath, "Export rendered source TIFF");
  await page.getByText(`Saved 40 × 32 · ${path.basename(renderedTiffPath)}`, { exact: true }).waitFor();
  const tiffInspectionScript = path.join(runRoot, "inspect_rendered_tiff.py");
  const tiffInspectionReport = path.join(runRoot, "rendered-tiff-inspection.json");
  await fs.writeFile(tiffInspectionScript, String.raw`import hashlib
import json
import sys
import numpy as np
import tifffile

source_path, rendered_path, report_path = sys.argv[1:]
with tifffile.TiffFile(source_path) as source_tif:
    source_axes = source_tif.series[0].axes
    source = source_tif.series[0].asarray()
with tifffile.TiffFile(rendered_path) as rendered_tif:
    assert len(rendered_tif.pages) == 1
    page = rendered_tif.pages[0]
    assert page.is_tiled and page.tilewidth == 256 and page.tilelength == 256
    assert page.dtype == np.dtype(np.uint16)
    assert page.shape == (32, 40, 3)
    assert 34675 in page.tags
    provenance = json.loads(page.description)
    observed = page.asarray()

selection = provenance["selection"]
index = []
for axis in source_axes:
    if axis == "T": index.append(selection["t"])
    elif axis == "C": index.append(slice(None))
    elif axis == "Z": index.append(selection["z"])
    elif axis == "Y": index.append(slice(selection["y"], selection["y"] + selection["height"]))
    elif axis == "X": index.append(slice(selection["x"], selection["x"] + selection["width"]))
    else: raise AssertionError(f"unexpected source axis {axis}")
selected = np.asarray(source[tuple(index)])
if "C" not in source_axes:
    selected = selected[None, ...]
elif source_axes.index("C") > source_axes.index("Y"):
    selected = np.moveaxis(selected, source_axes.replace("T", "").replace("Z", "").index("C"), 0)
expected = np.zeros((selection["height"], selection["width"], 3), dtype=np.float64)
for display in provenance["display"]:
    if not display["visible"] or display.get("opacity", 1) == 0: continue
    plane = selected[display["channel"]].astype(np.float64)
    normalized = np.clip((plane - display["low"]) / (display["high"] - display["low"]), 0, 1)
    normalized = np.power(normalized, 1 / display["gamma"]) * display.get("opacity", 1)
    color = np.array([int(display["color"][i:i + 2], 16) / 255 for i in (1, 3, 5)])
    expected += normalized[..., None] * color
expected = np.asarray(np.rint(np.clip(expected, 0, 1) * 65535), dtype=np.uint16)
delta = np.abs(observed.astype(np.int64) - expected.astype(np.int64))
report = {
    "schema": "loci.independent-rendered-tiff-inspection/v1",
    "shape_yxs": list(observed.shape),
    "dtype": str(observed.dtype),
    "tiled": True,
    "maximum_absolute_delta": int(delta.max()),
    "source_sha256": provenance["source_sha256"],
    "display_revision": provenance["display_revision"],
    "precision_policy": provenance["precision_policy"],
    "embedded_icc": True,
    "rendered_sha256": hashlib.sha256(open(rendered_path, "rb").read()).hexdigest(),
}
open(report_path, "w").write(json.dumps(report, indent=2) + "\n")
assert report["maximum_absolute_delta"] == 0
`);
  await run(independentPython, [tiffInspectionScript, scalarFixture, renderedTiffPath,
    tiffInspectionReport], { timeout: 120_000 });
  const tiffInspection = JSON.parse(await fs.readFile(tiffInspectionReport, "utf8"));
  assert.equal(tiffInspection.source_sha256, scalarSource.sha256);
  assert.equal(tiffInspection.maximum_absolute_delta, 0);
  const tiffBytes = await fs.readFile(renderedTiffPath);
  assert.ok(!tiffBytes.toString("latin1").includes(runRoot) &&
    !tiffBytes.toString("latin1").includes(scalarFixture),
  "The rendered TIFF disclosed a private local path.");
  renderedTiffExportEvidence = {
    file: path.basename(renderedTiffPath),
    sha256: await sha256(renderedTiffPath),
    bytes: tiffBytes.length,
    ...tiffInspection,
  };

  await selectTool("Analyze", "Analyze");
  await page.getByLabel("Threshold", { exact: true }).fill("50");
  const cameraBeforeResultRun = await scalarViewer.getAttribute("data-camera");
  await page.getByRole("button", { name: "Run recipe", exact: true }).click();
  await page.locator(".research-result-table tbody tr").first().waitFor({
    state: "visible",
    timeout: 120_000,
  });
  const snapshotAfterRun = await page.evaluate(() => window.lociResearch.getSnapshot());
  const resultCountBeforeSave = snapshotAfterRun.results.length;
  assert.ok(resultCountBeforeSave > 0, "The real UI run did not create a durable result.");
  const selectedResult = snapshotAfterRun.results.at(-1);
  assert.ok(selectedResult?.id && selectedResult?.revision_hash,
    "The real UI run did not expose an exact result revision.");
  const resultOverlayKey = `${selectedResult.id}:${selectedResult.revision_hash}`;
  await page.getByText(`Result on source · Z ${(selectedResult.selection?.z ?? 0) + 1}, T ${(selectedResult.selection?.t ?? 0) + 1}`,
    { exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(({ sourceId, overlayKey, camera }) => {
    const viewer = document.querySelector(`[data-viewer-source="${CSS.escape(sourceId)}"]`);
    return viewer?.getAttribute("data-result-overlay") === overlayKey &&
      viewer.getAttribute("data-camera") === camera;
  }, { sourceId: scalarSource.id, overlayKey: resultOverlayKey, camera: cameraBeforeResultRun },
  { timeout: 120_000 });
  assert.equal(await scalarViewer.getAttribute("data-viewer-source"), scalarSource.id,
    "The result overlay replaced or detached from its source viewer.");
  assert.equal(await scalarViewer.getAttribute("data-camera"), cameraBeforeResultRun,
    "Activating the result overlay changed the source camera.");
  assert.equal(await page.locator(".research-result-table tbody tr").count() > 0, true,
    "The result table disappeared while its result was shown on the source.");

  await scalarViewer.locator(".image-view-tools").getByRole("button", { name: "Zoom in" }).click();
  await page.waitForFunction(({ sourceId, camera }) => document.querySelector(
    `[data-viewer-source="${CSS.escape(sourceId)}"]`)?.getAttribute("data-camera") !== camera,
  { sourceId: scalarSource.id, camera: cameraBeforeResultRun });
  const overlayCameraAfterZoom = await scalarViewer.getAttribute("data-camera");
  assert.equal(await scalarViewer.getAttribute("data-result-overlay"), resultOverlayKey,
    "Zooming the shared source camera detached its result overlay.");
  const sourceCanvas = scalarViewer.getByLabel("Source image and bound annotations");
  const sourceCanvasBounds = await sourceCanvas.boundingBox();
  assert.ok(sourceCanvasBounds, "The shared source/result canvas has no bounds.");
  const centerX = sourceCanvasBounds.x + sourceCanvasBounds.width / 2;
  const centerY = sourceCanvasBounds.y + sourceCanvasBounds.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 42, centerY + 28, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(({ sourceId, camera }) => document.querySelector(
    `[data-viewer-source="${CSS.escape(sourceId)}"]`)?.getAttribute("data-camera") !== camera,
  { sourceId: scalarSource.id, camera: overlayCameraAfterZoom });
  const overlayCameraAfterPan = await scalarViewer.getAttribute("data-camera");
  assert.equal(await scalarViewer.getAttribute("data-result-overlay"), resultOverlayKey,
    "Panning the shared source camera detached its result overlay.");
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  await page.waitForFunction((sourceId) => !document.querySelector(
    `[data-viewer-source="${CSS.escape(sourceId)}"]`)?.hasAttribute("data-result-overlay"),
  scalarSource.id);
  assert.equal(await scalarViewer.getAttribute("data-camera"), overlayCameraAfterPan,
    "Returning to the source reset the shared source/result camera.");

  const rpcLatencies = await page.evaluate(async (sourceId) => {
    const defaults = await window.lociResearch.execute("viewer_defaults", {
      source_id: sourceId,
      t: 0,
      z: 0,
      auto: false,
    });
    const values = [];
    for (let index = 0; index < 12; index += 1) {
      const started = performance.now();
      await window.lociResearch.execute("viewer_tile", {
        source_id: sourceId,
        selection: {
          x: (index % 8) * 256,
          y: Math.floor(index / 8) * 256,
          width: 256,
          height: 256,
          z: 0,
          t: 0,
          c: 0,
          level: 0,
        },
        channels: defaults.channels,
      });
      values.push(performance.now() - started);
    }
    return values;
  }, pyramidSource.id);
  timing.viewer_tile_rpc_ms = {
    observations: rpcLatencies,
    median: percentile(rpcLatencies, 0.5),
    p95: percentile(rpcLatencies, 0.95),
  };

  const idleFrameIntervals = await page.evaluate(async () => {
    const values = [];
    let previous = performance.now();
    for (let index = 0; index < 90; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = performance.now();
      values.push(current - previous);
      previous = current;
    }
    return values;
  });
  timing.idle_90_animation_frame_ms = {
    label: "90 idle animation frames",
    observations: idleFrameIntervals.length,
    median: percentile(idleFrameIntervals, 0.5),
    p95: percentile(idleFrameIntervals, 0.95),
    p99: percentile(idleFrameIntervals, 0.99),
    max: Math.max(...idleFrameIntervals),
  };

  await pyramidButton.click();
  const navigationViewer = await waitForViewer(pyramidName);
  const navigationCacheBeforeNativeZoom = Number(
    await navigationViewer.getAttribute("data-cache-bytes"),
  );
  await navigationViewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  await page.waitForFunction(({ sourceId, previousBytes }) => {
    const viewer = document.querySelector(`[data-viewer-source="${CSS.escape(sourceId)}"]`);
    return viewer?.getAttribute("data-auto-level") === "0" &&
      Number(viewer.getAttribute("data-cache-bytes")) >= previousBytes &&
      !viewer.querySelector(".image-view-loading");
  }, { sourceId: pyramidSource.id, previousBytes: navigationCacheBeforeNativeZoom },
  { timeout: 120_000 });
  await selectTool("View", "Display");
  const navigationCanvas = navigationViewer.getByLabel("Source image and bound annotations");
  const navigationBounds = await navigationCanvas.boundingBox();
  assert.ok(navigationBounds && navigationBounds.width > 300 && navigationBounds.height > 250,
    "The 2D viewer is not usable at the qualification window size.");
  const navigationCenter = {
    x: navigationBounds.x + navigationBounds.width / 2,
    y: navigationBounds.y + navigationBounds.height / 2,
  };
  const dragPan = async (dx, dy) => {
    await page.mouse.move(navigationCenter.x, navigationCenter.y);
    await page.mouse.down({ button: "left" });
    for (let index = 1; index <= 60; index += 1) {
      await page.mouse.move(
        navigationCenter.x + dx * index / 60,
        navigationCenter.y + dy * index / 60,
      );
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "left" });
  };
  await dragPan(180, 104);
  await waitForViewer(pyramidName);
  // Tile requests coalesce during movement. Visit and settle both endpoints
  // before measuring the return path, so cancelled intermediate reads are not
  // mistaken for an already populated cache. The measured pass must still add
  // no cache bytes and meet the unchanged frame-time budgets.
  await dragPan(-180, -104);
  await waitForViewer(pyramidName);
  await dragPan(180, 104);
  await waitForViewer(pyramidName);
  const warmedPanCacheBytes = Number(await navigationViewer.getAttribute("data-cache-bytes"));
  const cameraBeforeMeasuredPan = await navigationViewer.getAttribute("data-camera");
  timing.cached_pan_animation_frames = await measureRafDuring(
    page,
    "sustained cached 2D pan",
    () => dragPan(-180, -104),
  );
  await waitForViewer(pyramidName);
  assert.notEqual(await navigationViewer.getAttribute("data-camera"), cameraBeforeMeasuredPan,
    "The sustained cached pan did not move the 2D camera.");
  assert.equal(Number(await navigationViewer.getAttribute("data-cache-bytes")), warmedPanCacheBytes,
    "The measured 2D pan left the warmed tile-cache path.");
  assert.ok(timing.cached_pan_animation_frames.p95_ms <= 33.4,
    `Cached 2D pan p95 exceeded 33.4 ms: ${timing.cached_pan_animation_frames.p95_ms}`);
  assert.ok(timing.cached_pan_animation_frames.p99_ms <= 50,
    `Cached 2D pan p99 exceeded 50 ms: ${timing.cached_pan_animation_frames.p99_ms}`);

  const wheelZoom = async (events) => {
    await page.mouse.move(navigationCenter.x, navigationCenter.y);
    for (let index = 0; index < events; index += 1) {
      await page.mouse.wheel(0, index % 2 === 0 ? -50 : 50);
      await page.waitForTimeout(20);
    }
  };
  await wheelZoom(48);
  await waitForViewer(pyramidName);
  const warmedWheelCacheBytes = Number(await navigationViewer.getAttribute("data-cache-bytes"));
  const cameraBeforeMeasuredWheel = await navigationViewer.getAttribute("data-camera");
  timing.cached_wheel_zoom_animation_frames = await measureRafDuring(
    page,
    "sustained cached 2D wheel zoom",
    () => wheelZoom(47),
  );
  await waitForViewer(pyramidName);
  assert.notEqual(await navigationViewer.getAttribute("data-camera"), cameraBeforeMeasuredWheel,
    "The sustained cached wheel zoom did not change the 2D camera.");
  assert.equal(Number(await navigationViewer.getAttribute("data-cache-bytes")), warmedWheelCacheBytes,
    "The measured 2D wheel zoom left the warmed tile-cache path.");
  assert.ok(timing.cached_wheel_zoom_animation_frames.p95_ms <= 33.4,
    `Cached 2D wheel zoom p95 exceeded 33.4 ms: ${timing.cached_wheel_zoom_animation_frames.p95_ms}`);
  assert.ok(timing.cached_wheel_zoom_animation_frames.p99_ms <= 50,
    `Cached 2D wheel zoom p99 exceeded 50 ms: ${timing.cached_wheel_zoom_animation_frames.p99_ms}`);

  settingsAndManualEvidence = await checkSettingsAndManual(page, screenshots);
  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await waitForFile(path.join(studyPath, "study.sqlite3"), "Save as study");
  await noUiError("Save as study");
  await page.locator(".session-save-state").filter({ hasText: /^Saved locally$/ }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  assert.equal(await page.locator("main.research-workbench").getAttribute("inert"), null,
    "The saved study remained locked after Save as study completed.");
  captures.saved = await capture("04-saved-study");
  await close();

  const reopenStart = performance.now();
  ({ instance: app, window: page, sampler: rssSampler } = await launch());
  await installDialogs("open");
  // Idle studies are offered on Open data; reopen the saved study explicitly.
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  timing.reopen_ms = performance.now() - reopenStart;
  const reopened = await page.evaluate(async () => {
    const snapshot = await window.lociResearch.getSnapshot();
    const pyramid = snapshot.sources.find((item) => item.name.includes("synthetic-pyramidal-colour"));
    return {
      snapshot,
      annotations: await window.lociResearch.execute("source_annotations", {
        source_id: pyramid.id,
      }),
    };
  });
  assert.equal(reopened.annotations.annotations.length, 1);
  assert.equal(reopened.annotations.annotations[0].label, "QA rectangle");
  assert.ok(reopened.snapshot.results.length >= resultCountBeforeSave);
  const reopenedResult = reopened.snapshot.results.find((item) => item.id === selectedResult.id);
  assert.equal(reopenedResult?.revision_hash, selectedResult.revision_hash,
    "The reopened study did not retain the exact result revision.");
  assert.equal(reopenedResult?.source_id, selectedResult.source_id,
    "The reopened result changed its source binding.");
  assert.equal(reopenedResult?.source_sha256, selectedResult.source_sha256,
    "The reopened result changed its source fingerprint.");
  const reopenedResultSource = reopened.snapshot.sources.find(
    (item) => item.id === reopenedResult.source_id,
  );
  assert.equal(reopenedResultSource?.sha256, selectedResult.source_sha256,
    "The reopened study did not retain the result's exact source.");
  const reopenedSourceButton = page.locator(".research-sources").getByRole("button", {
    name: reopenedResultSource.name,
  });
  await reopenedSourceButton.click();
  await reopenedSourceButton.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    ({ sourceId, sourceName }) => document.querySelector(
      `[data-viewer-source="${CSS.escape(sourceId)}"]`,
    ) &&
      [...document.querySelectorAll(".research-sources button")].some(
        (button) => button.getAttribute("aria-current") === "true" &&
          (button.title === sourceName ||
            button.dataset.lociHelp === sourceName ||
            button.querySelector(".research-source-name")?.textContent === sourceName),
      ),
    { sourceId: reopenedResultSource.id, sourceName: reopenedResultSource.name },
    { timeout: 120_000 },
  );
  const reopenedResultButton = page.locator(`[data-result-id="${selectedResult.id}"]`);
  await reopenedResultButton.waitFor({ state: "visible", timeout: 120_000 });
  await reopenedResultButton.click();
  await page.waitForFunction(({ sourceId, resultId, overlayKey }) => {
    const viewer = document.querySelector(`[data-viewer-source="${CSS.escape(sourceId)}"]`);
    const result = document.querySelector(`[data-result-id="${CSS.escape(resultId)}"]`);
    return result?.getAttribute("aria-pressed") === "true" &&
      viewer?.getAttribute("data-result-overlay") === overlayKey;
  }, {
    sourceId: reopenedResultSource.id,
    resultId: selectedResult.id,
    overlayKey: resultOverlayKey,
  }, { timeout: 120_000 });
  captures.reopened = await capture("05-reopened");
  await stopRssSampling();
  assert.equal(processTreeRss.length, 2,
    "Process-tree RSS evidence does not cover both application launches.");

  assert.deepEqual(pageErrors, [], "The real renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The real renderer emitted console errors.");
  const finalBuildIdentity = {
    ...buildIdentity,
    executable_sha256: await sha256(executablePath),
    worker_sha256: await sha256(workerPath),
    main_artifact_sha256: await sha256(mainArtifact),
    ...(packaged ? {} : {
      worker_client_source_sha256: await sha256(workerClientSource),
      worker_module_source_sha256: await sha256(workerModuleSource),
    }),
  };
  assert.deepEqual(finalBuildIdentity, buildIdentity,
    "The qualified application or worker artifacts changed during the journey.");
  assert.equal(await sha256(pyramidFixture), fixtureHashes.pyramid);
  assert.equal(await sha256(scalarFixture), fixtureHashes.scalar);

  // Keep the startup gate unchanged, but retain functional evidence even when
  // a cold launch misses its budget.
  assert.ok(timing.cold_launch_ms <= 8_000,
    `Cold launch exceeded 8 seconds: ${timing.cold_launch_ms} ms`);

  const report = {
    schema: packaged
      ? "loci.image-first-viewer-packaged-qa/v1"
      : "loci.image-first-viewer-development-qa/v1",
    status: "passed",
    started_at: startedAt,
    elapsed_seconds: (performance.now() - journeyStart) / 1000,
    invocation: packaged
      ? `LOCI_PACKAGED_APP=${packagedApp} node tests/image-first-viewer.qa.mjs`
      : "LOCI_QA_DEV=1 node tests/image-first-viewer.qa.mjs",
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: {
      pyramid: {
        path: pyramidFixture,
        sha256: fixtureHashes.pyramid,
        dimensions_yxs: [3072, 4096, 3],
        pyramid_levels: 3,
        synthetic_non_biological: true,
      },
      scalar: {
        path: scalarFixture,
        sha256: fixtureHashes.scalar,
        synthetic_non_biological: true,
      },
    },
    assertions: {
      cancelled_first_picker_allocated_session: false,
      source_identity_bound: true,
      full_fit_native_pyramid_level: initialLevel,
      native_zoom_level: 0,
      rectangle_save_undo_redo: true,
      annotation_export_import_source_bound: true,
      rendered_png_current_display_source_bound: true,
      rendered_tiff16_full_plane_exact_display_source_bound: true,
      source_specific_camera_and_channel_restore: true,
      result_overlay_shared_source_camera_navigation: true,
      saved_and_reopened_annotations_and_results: true,
      active_filename_geometry: labelGeometry,
      renderer_page_errors: pageErrors,
      renderer_console_errors: consoleErrors,
    },
    timing_ms: timing,
    performance_budgets: {
      cold_launch_ms: 8_000,
      first_native_detail_ms: 3_000,
      cached_2d_pan: { p95_ms: 33.4, p99_ms: 50 },
      cached_2d_wheel_zoom: { p95_ms: 33.4, p99_ms: 50 },
      idle_frames: { observations: 90, measured_separately: true },
    },
    process_resources: {
      sampled_launch_tree_rss: processTreeRss,
      launch_count: processTreeRss.length,
    },
    artifacts: {
      annotation_export: annotationExportEvidence,
      rendered_png_export: renderedExportEvidence,
      rendered_tiff16_export: renderedTiffExportEvidence,
    },
    captures,
    settings_and_manual: settingsAndManualEvidence,
    hardware: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
    run_root: runRoot,
  };
  await fs.writeFile(
    path.join(runRoot, "qa-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await capture("failure").catch(() => undefined);
  await fs.writeFile(
    path.join(runRoot, "qa-failure.json"),
    `${JSON.stringify({
      schema: packaged
        ? "loci.image-first-viewer-packaged-qa-failure/v1"
        : "loci.image-first-viewer-development-qa-failure/v1",
      error: String(error?.stack ?? error),
      source: sourceIdentity,
      build: buildIdentity,
      fixture_sha256: fixtureHashes,
      page_errors: pageErrors,
      console_errors: consoleErrors,
      captures,
    }, null, 2)}\n`,
  );
  throw error;
} finally {
  await close();
}
