import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { measureRafDuring, startProcessTreeRssSampler } from "./navigation-performance-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The image-first volume journey currently qualifies packaged Apple-silicon macOS builds.");

const development = process.env.LOCI_QA_DEV === "1";
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? path.join(
  desktopRoot, "..", ".loci", "builds", "current", "Loci.app",
));
const executablePath = development
  ? path.join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : path.join(appBundle, "Contents", "MacOS", "Loci");
const workerPath = development
  ? path.join(projectRoot, "engine", ".venv", "bin", "python")
  : path.join(appBundle, "Contents", "Resources", "loci-engine", "loci-engine");
const volumeSourcePath = path.join(projectRoot, "engine", "src", "loci_engine", "viewer_volume.py");
const applicationArtifact = development
  ? path.join(desktopRoot, ".vite", "build", "main.js")
  : path.join(appBundle, "Contents", "Resources", "app.asar");
const runName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first"), development ? "development-volume" : "packaged-volume",
), runName);
const fixturePath = path.join(runRoot, "synthetic-asymmetric-czyx.ome.tiff");
const studyPath = path.join(runRoot, "volume-journey.loci-study");
const wholeFigurePath = path.join(runRoot, "whole-volume.loci-figure");
const mprFocusFigurePath = path.join(runRoot, "mpr-focus.loci-figure");
const userData = path.join(runRoot, "user-data");
const screenshots = path.join(runRoot, "screenshots");
await Promise.all([fs.mkdir(userData, { recursive: true }), fs.mkdir(screenshots, { recursive: true })]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function generateFixture() {
  const generator = path.join(runRoot, "generate_fixture.py");
  await fs.writeFile(generator, String.raw`from pathlib import Path
import numpy as np
import tifffile

output = Path(${JSON.stringify(fixturePath)})
z, y, x = np.ogrid[:96, :192, :256]
first = (
    56000 * np.exp(-(((x - 77) / 36) ** 2 + ((y - 61) / 28) ** 2 + ((z - 29) / 16) ** 2))
    + 32000 * np.exp(-(((x - 174) / 23) ** 2 + ((y - 131) / 38) ** 2 + ((z - 68) / 12) ** 2))
)
ring_radius = np.sqrt(((x - 157) / 1.0) ** 2 + ((y - 72) / 0.85) ** 2)
second = (
    60000 * np.exp(-((ring_radius - 39) / 8) ** 2 - ((z - 51) / 11) ** 2)
    + 26000 * ((x > 32) & (x < 55) & (y > 118) & (y < 166) & (z > 15) & (z < 78))
)
volume = np.stack([np.clip(first, 0, 65535), np.clip(second, 0, 65535)]).astype(np.uint16)
tifffile.imwrite(output, volume, ome=True, photometric="minisblack", compression="deflate",
    metadata={"axes": "CZYX", "PhysicalSizeX": 0.4, "PhysicalSizeXUnit": "µm",
              "PhysicalSizeY": 0.8, "PhysicalSizeYUnit": "µm", "PhysicalSizeZ": 2.5,
              "PhysicalSizeZUnit": "µm", "Channel": {"Name": ["synthetic-core", "synthetic-ring"]}})
assert tifffile.imread(output).shape == (2, 96, 192, 256)
`);
  await run(path.join(projectRoot, "engine", ".venv", "bin", "python"), [generator], { timeout: 120_000 });
}
await generateFixture();
const fixtureSha256 = await sha256(fixturePath);
const resolvedVolumeModule = development
  ? (await run(workerPath, ["-c", "import loci_engine.viewer_volume as module; print(module.__file__)"], {
      cwd: path.join(projectRoot, "engine"),
    })).stdout.trim()
  : null;
if (development) {
  assert.equal(await fs.realpath(resolvedVolumeModule), await fs.realpath(volumeSourcePath),
    "The development worker environment does not resolve the qualified volume source.");
}
const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
const source = {
  head: await git("rev-parse", "HEAD"),
  status: await git("status", "--porcelain"),
  harness_sha256: await sha256(import.meta.filename),
};
const build = {
  mode: development ? "forge-development" : "packaged-adhoc",
  executable_sha256: await sha256(executablePath),
  worker_sha256: await sha256(workerPath),
  worker_mode: development ? "python-module:loci_engine.worker" : "frozen-executable",
  worker_cwd: development ? path.join(projectRoot, "engine") : null,
  resolved_volume_module: resolvedVolumeModule,
  volume_source_sha256: await sha256(volumeSourcePath),
  application_artifact: applicationArtifact,
  application_artifact_sha256: await sha256(applicationArtifact),
  viewport_source_sha256: await sha256(path.join(desktopRoot, "src", "renderer", "RawVolumeViewport.tsx")),
};

const marks = {};
const frameTiming = {};
const startedAt = new Date().toISOString();
const journeyStart = performance.now();
const launchStart = performance.now();
const app = await electron.launch({
  executablePath,
  args: [...(development ? [desktopRoot] : []), "--user-data-dir=" + userData],
  cwd: desktopRoot,
  timeout: 120_000,
});
const page = await app.firstWindow();
marks.cold_launch_ms = performance.now() - launchStart;
const rendererFailures = { page_errors: [], console_errors: [] };
page.on("pageerror", (error) => rendererFailures.page_errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") rendererFailures.console_errors.push(message.text());
});

async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown research UI error"}`);
}
async function screenshot(name, locator = page) {
  const target = path.join(screenshots, name + ".png");
  await locator.screenshot({ path: target });
  return { file: path.basename(target), sha256: await sha256(target), bytes: (await fs.stat(target)).size };
}
async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await noUiError(label);
    const result = await check();
    if (result) return result;
    await page.waitForTimeout(40);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function canvasCapture(name) {
  const stage = page.locator(".raw-volume-stage");
  await stage.locator("canvas").waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bytes = await stage.screenshot({ path: path.join(screenshots, name + ".png") });
  assert.ok(bytes.length > 2_000, `${name} did not contain a substantive rendered viewport`);
  const pixelStats = await app.evaluate(({ nativeImage }, encoded) => {
    const image = nativeImage.createFromDataURL(`data:image/png;base64,${encoded}`).resize({ width: 256, quality: "best" });
    const size = image.getSize();
    const bitmap = image.toBitmap();
    let bright = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      if (Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]) >= 48) bright += 1;
    }
    return { width: size.width, height: size.height, bright_pixels: bright };
  }, bytes.toString("base64"));
  return { file: name + ".png", sha256: hashBytes(bytes), bytes: bytes.length, pixel_stats: pixelStats };
}
async function viewportState() {
  return page.locator(".raw-volume").evaluate((element) => ({
    sourceId: element.getAttribute("data-source-id"),
    sourceSha256: element.getAttribute("data-source-sha256"),
    contextDimensions: element.getAttribute("data-context-dimensions"),
    contextByteLength: Number(element.getAttribute("data-context-byte-length")),
    contextLevel: Number(element.getAttribute("data-context-level")),
    focusExtent: element.getAttribute("data-focus-extent"),
    focusByteLength: Number(element.getAttribute("data-focus-byte-length")),
    focusNativeSteps: element.getAttribute("data-focus-native-steps"),
    transferRanges: element.getAttribute("data-transfer-ranges"),
    transferRangeBasis: element.getAttribute("data-transfer-range-basis"),
    status: element.querySelector(".raw-volume-status")?.textContent ?? "",
  }));
}
async function close() {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const done = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await done;
}
async function executingWorker() {
  const parentPid = app.process().pid;
  const output = (await run("ps", ["-ww", "-ax", "-o", "pid=,ppid=,command="])).stdout;
  const children = output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match && Number(match[2]) === parentPid
      ? [{ pid: Number(match[1]), command: match[3] }]
      : [];
  });
  const worker = children.find(({ command }) => development
    ? command.includes(workerPath) && command.includes("-m loci_engine.worker")
    : command.includes(workerPath));
  assert.ok(worker, `Could not prove the executing ${development ? "Python" : "frozen"} worker process.`);
  return { parent_pid: parentPid, pid: worker.pid, command: worker.command };
}

function finiteVector(value, length, label) {
  assert.ok(Array.isArray(value) && value.length === length && value.every(Number.isFinite),
    `${label} is not a finite ${length}-vector.`);
}

function assertNumbersClose(actual, expected, label) {
  finiteVector(actual, expected.length, label);
  actual.forEach((value, index) => assert.ok(
    Math.abs(value - expected[index]) <= 1e-9 * Math.max(1, Math.abs(expected[index])),
    `${label}[${index}] ${value} does not match ${expected[index]}.`,
  ));
}

function payloadWorld(payload, index) {
  return [0, 1, 2].map((row) => payload.origin_xyz[row] + [0, 1, 2].reduce(
    (total, column) => total + payload.direction_3x3[column * 3 + row] *
      payload.spacing_xyz[column] * index[column], 0,
  ));
}

function assertPayloadGrid(payload, expected) {
  assert.equal(payload.role, expected.role);
  assert.match(payload.data_sha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.t, 0);
  assert.deepEqual(payload.source_dimensions_xyz, [256, 192, 96]);
  assert.deepEqual(payload.dimensions_xyz, expected.dimensions);
  assert.deepEqual(payload.component_indices, [0, 1]);
  assert.deepEqual(payload.source_dtypes, ["uint16", "uint16"]);
  assert.equal(payload.scalar_type, "uint16");
  assert.equal(payload.unit, "um");
  assert.equal(payload.frame, "image");
  assert.equal(payload.sampling.source_indices_xyz.length, 3);
  assert.equal(payload.sampling.level_zero_indices_xyz.length, 3);
  payload.dimensions_xyz.forEach((length, axis) => {
    assert.equal(payload.sampling.source_indices_xyz[axis].length, length);
    assert.equal(payload.sampling.level_zero_indices_xyz[axis].length, length);
  });
}

async function inspectFigureBundle(destination, expected) {
  const destinationStat = await fs.lstat(destination);
  assert.ok(destinationStat.isDirectory() && !destinationStat.isSymbolicLink(),
    `${path.basename(destination)} is not a real published directory.`);
  assert.deepEqual((await fs.readdir(destination)).sort(), ["image.png", "manifest.json"]);
  const imagePath = path.join(destination, "image.png");
  const manifestPath = path.join(destination, "manifest.json");
  const [imageBytes, manifestBytes] = await Promise.all([fs.readFile(imagePath), fs.readFile(manifestPath)]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const hashes = { "image.png": hashBytes(imageBytes), "manifest.json": hashBytes(manifestBytes) };
  assert.equal(manifest.schema_version, "loci.volume-figure/v1");
  assert.deepEqual(manifest.source, { source_id: expected.sourceId, source_sha256: fixtureSha256, t: 0 });
  assert.deepEqual(manifest.representation, {
    mode: expected.mode, extent: expected.extent, interpolation: "linear", shading: false, lighting: null, orientation_axes: true,
  });
  assertPayloadGrid(manifest.payloads.context, {
    role: "whole-volume-context", dimensions: expected.contextDimensions,
  });
  assert.ok(manifest.payloads.focus, "The exported figure omitted the verified focus grid.");
  assertPayloadGrid(manifest.payloads.focus, {
    role: "level-zero-focus", dimensions: expected.focusDimensions,
  });
  assert.deepEqual(manifest.payloads.focus.source_extent_xyzxyz, expected.focusExtent);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.channel_index), [0, 1]);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.name), ["synthetic-core", "synthetic-ring"]);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.visible), [true, true]);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.opacity), [1, 0.25]);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.color_mode),
    [expected.mode === "volume" ? "constant" : "intensity", expected.mode === "volume" ? "constant" : "intensity"]);
  assert.deepEqual(manifest.transfers.map((transfer) => transfer.window), expected.windows);
  manifest.transfers.forEach((transfer) => {
    assert.equal(transfer.resolved_points.length, 5);
    assert.ok(transfer.resolved_points.every((point) => Number.isFinite(point.scalar) &&
      Number.isFinite(point.opacity) && point.color_rgb.every(Number.isFinite)));
    if (expected.mode === "volume") assert.ok(Number.isFinite(transfer.opacity_unit_distance));
    else assert.equal(transfer.opacity_unit_distance, null);
  });
  assert.equal(manifest.camera.projection, "perspective");
  finiteVector(manifest.camera.position_xyz, 3, "camera position");
  finiteVector(manifest.camera.focal_point_xyz, 3, "camera focal point");
  finiteVector(manifest.camera.view_up_xyz, 3, "camera view-up");
  finiteVector(manifest.camera.clipping_range, 2, "camera clipping range");
  assert.ok(manifest.camera.clipping_range[1] > manifest.camera.clipping_range[0]);
  assert.ok(Number.isFinite(manifest.camera.view_angle_degrees));
  assert.equal(manifest.camera.parallel_scale, null);
  assert.equal(manifest.clipping.enabled, true);
  assert.equal(manifest.clipping.axis, "x");
  assert.equal(manifest.clipping.position_percent, 62);
  const clippingDisplayIndex = [(manifest.payloads.context.dimensions_xyz[0] - 1) * 0.62, 0, 0];
  assertNumbersClose(manifest.clipping.plane_origin_xyz,
    payloadWorld(manifest.payloads.context, clippingDisplayIndex), "clipping origin");
  assertNumbersClose(manifest.clipping.plane_normal_xyz,
    manifest.payloads.context.direction_3x3.slice(0, 3), "clipping normal");
  if (expected.mode === "volume") assert.equal(manifest.mpr, null);
  else {
    const expectedSourceIndices = [91, 73, 31];
    assert.deepEqual(manifest.mpr.source_indices_xyz, expectedSourceIndices);
    const expectedContextIndices = expectedSourceIndices.map((sourceIndex, axis) => {
      const indices = manifest.payloads.context.sampling.level_zero_indices_xyz[axis];
      return indices.reduce((nearest, value, index) =>
        Math.abs(value - sourceIndex) < Math.abs(indices[nearest] - sourceIndex) ? index : nearest, 0);
    });
    assert.deepEqual(manifest.mpr.context_display_indices_xyz, expectedContextIndices);
    const expectedActiveIndices = expectedSourceIndices.map((sourceIndex, axis) => {
      const indices = manifest.payloads.focus.sampling.level_zero_indices_xyz[axis];
      return indices.reduce((nearest, value, index) =>
        Math.abs(value - sourceIndex) < Math.abs(indices[nearest] - sourceIndex) ? index : nearest, 0);
    });
    assert.deepEqual(manifest.mpr.active_payload_indices_xyz, expectedActiveIndices);
    assertNumbersClose(manifest.mpr.world_xyz,
      payloadWorld(manifest.payloads.context, expectedContextIndices), "MPR world position");
  }
  assert.equal(manifest.artifact.name, "image.png");
  assert.equal(manifest.artifact.sha256, hashes["image.png"]);
  assert.equal(manifest.artifact.size_bytes, imageBytes.length);
  assert.equal(manifest.artifact.width_px, manifest.figure.width_px);
  assert.equal(manifest.artifact.height_px, manifest.figure.height_px);
  assert.deepEqual([manifest.figure.width_px, manifest.figure.height_px], expected.canvasDimensions,
    "The stored PNG dimensions do not match the native VTK canvas used for this export.");
  assert.equal(manifest.figure.capture_scale, 1);
  assert.equal(manifest.software.renderer, "vtk.js");
  assert.equal(manifest.software.renderer_version, "36.12.0");
  assert.equal(manifest.software.capture_method, "captureNextImage");
  assert.equal(manifest.software.application, "Loci");
  const decoded = await app.evaluate(({ nativeImage }, encoded) => {
    const image = nativeImage.createFromBuffer(Buffer.from(encoded, "base64"));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    let differentFromFirst = 0;
    const first = bitmap.subarray(0, 4);
    for (let index = 4; index < bitmap.length; index += 4) {
      if (bitmap[index] !== first[0] || bitmap[index + 1] !== first[1] ||
          bitmap[index + 2] !== first[2] || bitmap[index + 3] !== first[3]) differentFromFirst += 1;
    }
    return { width: size.width, height: size.height, bitmap_bytes: bitmap.length, different_from_first: differentFromFirst };
  }, imageBytes.toString("base64"));
  assert.deepEqual([decoded.width, decoded.height], [manifest.figure.width_px, manifest.figure.height_px]);
  assert.equal(decoded.bitmap_bytes, decoded.width * decoded.height * 4);
  assert.ok(decoded.different_from_first > 500,
    `Independent PNG decode found only ${decoded.different_from_first} pixels different from the first pixel.`);
  return {
    basename: path.basename(destination), hashes, bytes: { image: imageBytes.length, manifest: manifestBytes.length },
    manifest, independent_png_decode: decoded,
  };
}

async function bundleFingerprint(destination) {
  const [directory, image, manifest] = await Promise.all([
    fs.stat(destination, { bigint: true }), fs.readFile(path.join(destination, "image.png")),
    fs.readFile(path.join(destination, "manifest.json")),
  ]);
  return {
    directory_inode: String(directory.ino), directory_mtime_ns: String(directory.mtimeNs),
    image_sha256: hashBytes(image), manifest_sha256: hashBytes(manifest),
  };
}

const captures = {};
let report;
let rssSampler = null;
try {
  const rssSamplingStartedAt = new Date().toISOString();
  const rssSamplingStartedAfterJourneyMs = performance.now() - journeyStart;
  rssSampler = await startProcessTreeRssSampler(app.process().pid, {
    intervalMs: 200,
    workerCommandIncludes: development ? "-m loci_engine.worker" : workerPath,
  });
  await app.evaluate(({ BrowserWindow, dialog }, values) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ width: 1440, height: 960 });
    window.show();
    window.focus();
    window.moveTop();
    dialog.showOpenDialog = async (...args) => args.at(-1)?.title === "Add microscopy or medical images"
      ? { canceled: false, filePaths: [values.fixture] }
      : { canceled: true, filePaths: [] };
    const figureDestinations = [...values.figureDestinations];
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title === "Create research study") return { canceled: false, filePath: values.study };
      if (title === "Export volume figure") {
        const filePath = figureDestinations.shift();
        if (!filePath) throw new Error("The volume QA journey received an unexpected figure picker.");
        return { canceled: false, filePath };
      }
      return { canceled: true, filePath: undefined };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, {
    fixture: fixturePath,
    study: studyPath,
    figureDestinations: [wholeFigurePath, mprFocusFigurePath, wholeFigurePath],
  });
  await app.evaluate(({ app: electronApp }) => electronApp.focus({ steal: true }));
  await page.bringToFront();

  const settingsButton = page.getByRole("button", { name: "Open settings", exact: true });
  await waitFor(
    async () => await settingsButton.getAttribute("data-loci-help") === "Appearance and preferences",
    "welcome context-help instrumentation",
    10_000,
  );
  await page.evaluate(() => {
    window.__lociVolumeQaHoverEvents = [];
    for (const type of ["pointerover", "mouseover"])
      document.addEventListener(type, (event) => {
        const owner = event.target instanceof Element ? event.target.closest("[data-loci-help]") : null;
        if (owner?.getAttribute("aria-label") === "Open settings")
          window.__lociVolumeQaHoverEvents.push(type);
      }, { capture: true });
  });
  await page.mouse.move(720, 700);
  const settingsBounds = await settingsButton.boundingBox();
  assert.ok(settingsBounds, "Instrumented settings control has no visible bounds.");
  await page.mouse.move(
    settingsBounds.x + settingsBounds.width / 2,
    settingsBounds.y + settingsBounds.height / 2,
    { steps: 4 },
  );
  await page.waitForTimeout(700);
  const welcomeHoverEvents = await page.evaluate(() => window.__lociVolumeQaHoverEvents);
  assert.ok(welcomeHoverEvents.includes("pointerover") || welcomeHoverEvents.includes("mouseover"),
    `Hover did not enter the instrumented settings control (${JSON.stringify(welcomeHoverEvents)}).`);
  const tooltip = page.getByRole("tooltip");
  if (!await tooltip.isVisible().catch(() => false)) {
    // A newly activated packaged macOS window can retain the system pointer at
    // the control while its first delayed tooltip is cancelled by activation.
    // Leave and re-enter with another genuine Playwright pointer movement.
    await page.mouse.move(720, 700);
    await page.waitForTimeout(150);
    await settingsButton.hover({ force: true });
  }
  await tooltip.waitFor({ state: "visible", timeout: 2_000 });
  assert.equal(await tooltip.textContent(), "Appearance and preferences");
  captures.welcomeHoverTooltip = await screenshot("00a-welcome-hover-tooltip");
  await page.mouse.move(720, 700);
  await tooltip.waitFor({ state: "hidden", timeout: 2_000 });
  await page.keyboard.press("Tab");
  await settingsButton.focus();
  await tooltip.waitFor({ state: "visible", timeout: 2_000 });
  assert.equal(await tooltip.textContent(), "Appearance and preferences");
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden", timeout: 2_000 });
  assert.equal(await settingsButton.getAttribute("aria-describedby"), null);

  const importStart = performance.now();
  const openImages = page.getByRole("button", { name: "Open images", exact: true });
  await openImages.waitFor({ state: "visible", timeout: 30_000 });
  await openImages.click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 120_000 });
  const sourceButton = page.locator(".research-sources").getByRole("button", { name: /^synthetic-asymmetric-czyx\.ome\.tiff/ });
  await sourceButton.waitFor({ state: "visible", timeout: 120_000 });
  marks.import_ms = performance.now() - importStart;
  const secondVisible = page.getByLabel("Channel 2 visible", { exact: true });
  await secondVisible.waitFor({ state: "visible" });
  if (!await secondVisible.isChecked()) await secondVisible.check();
  // The reversible channel choice is autosaved after a 400 ms debounce.  Let
  // that exact source-view revision commit before starting the independent
  // viewer worker request, as a human naturally does while scanning the image.
  await page.waitForTimeout(1_000);
  const snapshotBefore = await page.evaluate(() => window.lociResearch.getSnapshot());
  const sourceRecord = snapshotBefore.sources.find((item) => item.name === "synthetic-asymmetric-czyx.ome.tiff");
  assert.ok(sourceRecord, "Imported synthetic source is absent from the managed study.");
  assert.equal(sourceRecord.sha256, fixtureSha256, "Managed source binding does not match the fixture bytes.");

  const volumeStart = performance.now();
  const volumeButton = page.getByRole("button", { name: "3D volume", exact: true });
  await volumeButton.hover();
  await tooltip.waitFor({ state: "visible", timeout: 2_000 });
  captures.volumeButtonTooltip = await screenshot("00b-volume-button-hover-tooltip");
  await volumeButton.click();
  await tooltip.waitFor({ state: "hidden", timeout: 2_000 });
  const viewport = page.locator(".raw-volume");
  await viewport.waitFor({ state: "visible" });
  const coarse = await waitFor(async () => {
    const value = await viewportState();
    return value.contextDimensions === "128x96x48" && value.status.includes("display") ? value : null;
  }, "the bounded 128-voxel whole-volume context");
  marks.initial_volume_ms = performance.now() - volumeStart;
  assert.equal(coarse.sourceSha256, fixtureSha256);
  assert.equal(coarse.contextByteLength, 128 * 96 * 48 * 2 * 2);
  assert.match(coarse.transferRangeBasis, /bounded-context-histogram-p1-p99-2048bins/);
  assert.doesNotMatch(coarse.transferRanges, /0:65535/);
  build.executing_worker = await executingWorker();
  captures.coarse = await canvasCapture("01-coarse-volume");
  captures.volumeActivated = await screenshot("01b-volume-activated-no-tooltip");

  const refined = await waitFor(async () => {
    const value = await viewportState();
    return value.contextDimensions === "256x192x96" && value.status.includes("display") ? value : null;
  }, "automatic full-resolution refinement");
  marks.automatic_refinement_ms = performance.now() - volumeStart;
  assert.equal(refined.contextByteLength, 256 * 192 * 96 * 2 * 2);
  captures.refined = await canvasCapture("02-refined-volume");
  const refinedPixels = captures.refined.pixel_stats;
  assert.ok(refinedPixels.bright_pixels > 500, "The refined volume canvas does not contain substantive bright structure.");

  const planeNames = ["XY plane", "XZ plane", "YZ plane"];
  const planeEvidence = [];
  for (const name of planeNames) {
    const pane = page.getByRole("region", { name: `${name} view`, exact: true });
    await pane.waitFor({ state: "visible" });
    const pixels = await pane.locator("canvas").evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let bright = 0;
      for (let offset = 0; offset < data.length; offset += 4)
        if (Math.max(data[offset], data[offset + 1], data[offset + 2]) >= 48) bright++;
      return { width: canvas.width, height: canvas.height, bright };
    });
    assert.ok(pixels.bright > 100, `${name} is blank despite verified volume data.`);
    planeEvidence.push({ name, ...pixels });
    await page.getByRole("button", { name: `Expand ${name} view`, exact: true }).click();
    assert.equal(await page.locator(".mpr-pane:visible").count(), 1, "Expanding a plane did not isolate it.");
    await page.getByRole("button", { name: `Restore ${name} view`, exact: true }).click();
    assert.equal(await page.locator(".mpr-pane:visible").count(), 4, "Restore did not recover all four panes.");
  }
  const zBefore = Number(await page.getByLabel("Z slice", { exact: true }).inputValue());
  await page.getByLabel("XY plane slice navigation", { exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(Number(await page.getByLabel("Z slice", { exact: true }).inputValue()), zBefore + 1,
    "Linked crosshair did not advance one anisotropic source slice.");
  await page.keyboard.press("ArrowDown");
  captures.fourPanes = { ...await screenshot("02b-four-linked-planes"), planes: planeEvidence };
  await page.getByRole("button", { name: "Expand 3D view", exact: true }).click();
  assert.equal(await page.locator(".mpr-pane:visible").count(), 1);
  await page.getByRole("button", { name: "Restore 3D view", exact: true }).click();
  await page.getByRole("button", { name: "3D view", exact: true }).click();
  assert.equal(await page.locator(".mpr-pane:visible").count(), 1);
  captures.refined = await canvasCapture("02c-full-3d-volume");

  const stage = page.locator(".raw-volume-stage");
  const box = await stage.boundingBox();
  assert.ok(box && box.width > 300 && box.height > 250, "Volume viewport is not usable at the packaged window size.");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await stage.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
  captures.keyboardOrbit = await canvasCapture("03-keyboard-orbit");
  assert.notEqual(captures.keyboardOrbit.sha256, captures.refined.sha256,
    "Keyboard orbit did not change the rendered view.");
  await page.keyboard.press("r");
  await page.waitForTimeout(120);
  captures.cameraReset = await canvasCapture("04-camera-reset");
  assert.equal(captures.cameraReset.sha256, captures.refined.sha256,
    "Camera reset did not restore the initial fitted orientation.");
  const orbitStart = performance.now();
  frameTiming.orbit = await measureRafDuring(page, "sustained-left-drag-orbit", async () => {
    await page.mouse.move(centre.x - 45, centre.y - 20);
    await page.mouse.down({ button: "left" });
    for (let index = 1; index <= 60; index += 1) {
      await page.mouse.move(centre.x - 45 + (110 * index / 60), centre.y - 20 + (55 * index / 60));
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "left" });
  });
  await page.waitForTimeout(120);
  marks.orbit_ms = performance.now() - orbitStart;
  captures.orbit = await canvasCapture("05-orbit");
  assert.notEqual(captures.orbit.sha256, captures.refined.sha256, "Orbit did not change the rendered view.");

  const panStart = performance.now();
  frameTiming.pan = await measureRafDuring(page, "sustained-right-drag-pan", async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down({ button: "right" });
    for (let index = 1; index <= 60; index += 1) {
      await page.mouse.move(centre.x + (55 * index / 60), centre.y - (32 * index / 60));
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "right" });
  });
  await page.waitForTimeout(120);
  marks.pan_ms = performance.now() - panStart;
  captures.pan = await canvasCapture("06-pan");
  assert.notEqual(captures.pan.sha256, captures.orbit.sha256, "Pan did not change the rendered view.");

  const zoomStart = performance.now();
  await page.mouse.move(centre.x, centre.y);
  frameTiming.zoom = await measureRafDuring(page, "sustained-wheel-zoom", async () => {
    for (let index = 0; index < 43; index += 1) {
      await page.mouse.wheel(0, index < 40 ? (index % 2 === 0 ? -8 : 8) : -8);
      await page.waitForTimeout(20);
    }
  });
  await page.waitForTimeout(120);
  marks.zoom_ms = performance.now() - zoomStart;
  captures.zoom = await canvasCapture("07-zoom");
  assert.notEqual(captures.zoom.sha256, captures.pan.sha256, "Zoom did not change the rendered view.");

  const ringVisible = page.getByLabel("synthetic-ring visible", { exact: true });
  await ringVisible.uncheck();
  await page.waitForTimeout(120);
  captures.singleChannel = await canvasCapture("08-single-channel");
  assert.notEqual(captures.singleChannel.sha256, captures.zoom.sha256, "Channel visibility did not change the rendered view.");
  await ringVisible.check();
  await page.locator("details.raw-volume-channel").filter({ hasText: "synthetic-ring" }).locator("summary").click();
  await page.getByLabel("synthetic-ring opacity", { exact: true }).fill("0.25");
  await page.waitForTimeout(120);
  captures.channelOpacity = await canvasCapture("09-channel-opacity");
  assert.notEqual(captures.channelOpacity.sha256, captures.singleChannel.sha256, "Channel opacity did not change the rendered view.");

  await page.getByLabel("Clip", { exact: true }).check();
  await page.getByLabel("Clipping axis", { exact: true }).selectOption("0");
  await page.getByLabel("Clipping position", { exact: true }).fill("62");
  await page.waitForTimeout(120);
  captures.clipped = await canvasCapture("10-clipped-x");
  assert.notEqual(captures.clipped.sha256, captures.channelOpacity.sha256, "Clipping did not change the rendered view.");

  await page.getByRole("button", { name: "MPR", exact: true }).click();
  await page.getByLabel("X slice", { exact: true }).fill("91");
  await page.getByLabel("Y slice", { exact: true }).fill("73");
  await page.getByLabel("Z slice", { exact: true }).fill("31");
  await page.waitForTimeout(120);
  captures.mpr = await canvasCapture("11-mpr-crosshair");
  assert.notEqual(captures.mpr.sha256, captures.clipped.sha256, "MPR mode did not change the rendered view.");

  const focusStart = performance.now();
  await page.getByRole("button", { name: "Detail at crosshair", exact: true }).click();
  const focused = await waitFor(async () => {
    const value = await viewportState();
    return value.focusExtent && value.focusByteLength > 0 && value.status.includes("display") ? value : null;
  }, "level-zero focus detail");
  marks.focus_refinement_ms = performance.now() - focusStart;
  assert.match(focused.focusExtent, /^\d+,\d+,\d+,\d+,\d+,\d+$/);
  assert.equal(focused.focusNativeSteps, "true", "Focus detail did not preserve native level-zero steps.");
  captures.focus = await canvasCapture("12-focus-detail");

  const contextLoss = await page.locator(".raw-volume-stage canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    window.__lociVolumeQaContextExtension = extension;
    extension?.loseContext();
    return Boolean(extension);
  });
  assert.equal(contextLoss, true, "WEBGL_lose_context is unavailable in the packaged renderer.");
  await waitFor(async () => (await viewportState()).status.includes("Graphics context lost"), "explicit WebGL context loss", 10_000);
  captures.contextLost = await screenshot("13-context-lost", viewport);
  await page.locator(".raw-volume-stage canvas").evaluate(() => {
    window.__lociVolumeQaContextExtension?.restoreContext();
    delete window.__lociVolumeQaContextExtension;
  });
  await waitFor(async () => (await viewportState()).status.includes("display"), "WebGL context restoration", 20_000);
  captures.restored = await canvasCapture("14-context-restored");
  const restoredPixels = captures.restored.pixel_stats;
  assert.ok(restoredPixels.bright_pixels > 500,
    `WebGL restoration reported ready with only ${restoredPixels.bright_pixels} bright canvas pixels.`);
  assert.ok(restoredPixels.bright_pixels >= captures.focus.pixel_stats.bright_pixels * 0.8,
    "WebGL restoration did not preserve a comparable visible MPR area.");
  await page.waitForTimeout(600);
  const settled = await viewportState();
  assert.ok(settled.focusExtent && !settled.status.startsWith("Loading"),
    "The restored focus view did not remain settled after its refinement debounce window.");
  for (const sample of Object.values(frameTiming)) {
    assert.ok(sample.p95_ms <= 50,
      `${sample.label} p95 frame interval ${sample.p95_ms.toFixed(1)} ms exceeded the 50 ms M1/8 GB budget.`);
    assert.ok(sample.p99_ms <= 100,
      `${sample.label} p99 frame interval ${sample.p99_ms.toFixed(1)} ms exceeded the 100 ms M1/8 GB budget.`);
  }

  const processTreeRss = {
    sampling_started_at: rssSamplingStartedAt,
    sampling_started_after_journey_ms: rssSamplingStartedAfterJourneyMs,
    sampling_start_boundary:
      "after electron.launch() resolved and app.firstWindow() returned; before window setup, import, and decode; launch-to-first-window startup is excluded",
    ...await rssSampler.stop(),
  };
  rssSampler = null;
  assert.ok(processTreeRss.matching_workers_aggregate.peak_kb > 0,
    "RSS sampling did not observe any executing Loci worker.");

  const volumeChannels = page.locator("details.raw-volume-channel");
  assert.equal(await volumeChannels.count(), 2, "The two native volume components are not exposed independently.");
  for (let index = 0; index < 2; index += 1) {
    const channel = volumeChannels.nth(index);
    if (!await channel.evaluate((element) => element.open)) await channel.locator("summary").click();
  }
  const histogramPanels = page.locator(".raw-volume-histogram");
  await waitFor(async () => await histogramPanels.count() === 2, "both native volume histograms", 10_000);
  const histogramBeforeNavigation = await histogramPanels.evaluateAll((panels) => panels.map((panel) => ({
    text: panel.textContent,
    aria: panel.querySelector("svg")?.getAttribute("aria-label"),
    title: panel.querySelector("title")?.textContent,
    path: panel.querySelector("path")?.getAttribute("d"),
  })));
  assert.deepEqual(histogramBeforeNavigation.map((item) => item.aria), [
    "synthetic-core whole-context display volume histogram",
    "synthetic-ring whole-context display volume histogram",
  ]);
  histogramBeforeNavigation.forEach((item) => {
    assert.match(item.text, /Whole-context display sample · level 0 · T 0 · 131,072 values · inclusive linear index v1/);
    assert.match(item.title, /131,072 sampled values/);
    assert.equal((item.path.match(/[ML]/g) ?? []).length, 256,
      "A native volume histogram did not expose all 256 bounded bins.");
  });
  const postTimingBox = await stage.boundingBox();
  assert.ok(postTimingBox, "The volume stage disappeared before histogram navigation stability checks.");
  const postTimingCentre = {
    x: postTimingBox.x + postTimingBox.width / 2,
    y: postTimingBox.y + postTimingBox.height / 2,
  };
  await page.mouse.move(postTimingCentre.x, postTimingCentre.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(postTimingCentre.x + 18, postTimingCentre.y - 11, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await page.mouse.wheel(0, -24);
  await page.waitForTimeout(120);
  const histogramAfterNavigation = await histogramPanels.evaluateAll((panels) => panels.map((panel) => ({
    text: panel.textContent,
    aria: panel.querySelector("svg")?.getAttribute("aria-label"),
    title: panel.querySelector("title")?.textContent,
    path: panel.querySelector("path")?.getAttribute("d"),
  })));
  assert.deepEqual(histogramAfterNavigation, histogramBeforeNavigation,
    "Pan or zoom changed the source-bound whole-context histogram sample.");

  const readTransferWindows = async () => Promise.all(["synthetic-core", "synthetic-ring"].map(async (name) => ({
    low: Number(await page.getByLabel(`${name} low`, { exact: true }).inputValue()),
    high: Number(await page.getByLabel(`${name} high`, { exact: true }).inputValue()),
    gamma: Number(await page.getByLabel(`${name} gamma`, { exact: true }).inputValue()),
  })));
  const windowsBeforeTrim = await readTransferWindows();
  const beforeTrimCanvas = await canvasCapture("15-before-histogram-trim");
  const trimButtons = page.getByRole("button", { name: "Trim 1–99%", exact: true });
  assert.equal(await trimButtons.count(), 2, "Each native volume component needs its own percentile trim control.");
  await trimButtons.nth(0).evaluate((button) => button.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.waitForTimeout(120);
  const [firstTrimBounds, workbenchFooterBounds, viewportSize] = await Promise.all([
    trimButtons.nth(0).boundingBox(),
    page.locator("footer.workbench-status").boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  assert.ok(firstTrimBounds && workbenchFooterBounds,
    "The first percentile control or persistent workbench footer has no measurable bounds.");
  assert.ok(firstTrimBounds.y >= 0 && firstTrimBounds.x >= 0 &&
    firstTrimBounds.x + firstTrimBounds.width <= viewportSize.width &&
    firstTrimBounds.y + firstTrimBounds.height <= workbenchFooterBounds.y,
  "Ordinary centre scrolling could not place the first percentile control fully above the persistent footer.");
  await trimButtons.nth(0).click();
  await trimButtons.nth(1).focus();
  assert.equal(await trimButtons.nth(1).evaluate((button) => document.activeElement === button), true,
    "The second native percentile trim did not receive keyboard focus.");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const windowsAfterTrim = await readTransferWindows();
  assert.ok(windowsAfterTrim.every((window, index) =>
    window.low !== windowsBeforeTrim[index].low || window.high !== windowsBeforeTrim[index].high),
  "The native percentile controls did not update both display transfer ranges.");
  const afterTrimCanvas = await canvasCapture("16-after-histogram-trim");
  assert.notEqual(afterTrimCanvas.sha256, beforeTrimCanvas.sha256,
    "Percentile trimming changed controls but not the rendered display.");
  assert.equal(await sha256(fixturePath), fixtureSha256,
    "Histogram navigation or percentile trimming changed the source bytes.");

  const focusExtent = focused.focusExtent.split(",").map(Number);
  const focusDimensions = [0, 1, 2].map((axis) => focusExtent[axis * 2 + 1] - focusExtent[axis * 2] + 1);
  const contextDimensions = focused.contextDimensions.split("x").map(Number);
  const volumeMode = page.getByRole("button", { name: "Volume", exact: true });
  const mprMode = page.getByRole("button", { name: "MPR", exact: true });
  const wholeExtent = page.getByRole("button", { name: "Whole", exact: true });
  const focusExtentButton = page.getByRole("button", { name: "Focus", exact: true });
  const exportButton = page.getByRole("button", { name: "Export PNG…", exact: true });

  await volumeMode.click();
  await wholeExtent.click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await volumeMode.getAttribute("aria-pressed"), "true");
  assert.equal(await wholeExtent.getAttribute("aria-pressed"), "true");
  const wholeCanvasDimensions = await page.locator(".raw-volume-stage canvas").evaluate((canvas) =>
    [canvas.width, canvas.height]);
  await exportButton.click();
  const wholeSaved = page.locator(".raw-volume-export-status[role=status]");
  await wholeSaved.waitFor({ state: "visible", timeout: 120_000 });
  await waitFor(async () => fs.lstat(wholeFigurePath).then((stat) => stat.isDirectory()).catch(() => false),
    "atomic whole-volume figure publication");
  const wholeFigure = await inspectFigureBundle(wholeFigurePath, {
    sourceId: sourceRecord.id,
    mode: "volume",
    extent: "context",
    contextDimensions,
    focusDimensions,
    focusExtent,
    windows: windowsAfterTrim,
    canvasDimensions: wholeCanvasDimensions,
  });
  assert.equal(await wholeSaved.textContent(),
    `Saved ${wholeFigure.manifest.figure.width_px} × ${wholeFigure.manifest.figure.height_px} · whole-volume.loci-figure`);

  await mprMode.click();
  await focusExtentButton.click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await mprMode.getAttribute("aria-pressed"), "true");
  assert.equal(await focusExtentButton.getAttribute("aria-pressed"), "true");
  const mprCanvasDimensions = await page.locator(".raw-volume-stage canvas").evaluate((canvas) =>
    [canvas.width, canvas.height]);
  await exportButton.click();
  await waitFor(async () => fs.lstat(mprFocusFigurePath).then((stat) => stat.isDirectory()).catch(() => false),
    "atomic focused-MPR figure publication");
  const mprFocusFigure = await inspectFigureBundle(mprFocusFigurePath, {
    sourceId: sourceRecord.id,
    mode: "mpr",
    extent: "focus",
    contextDimensions,
    focusDimensions,
    focusExtent,
    windows: windowsAfterTrim,
    canvasDimensions: mprCanvasDimensions,
  });
  const mprSaved = page.locator(".raw-volume-export-status[role=status]");
  await waitFor(async () => (await mprSaved.textContent()) ===
    `Saved ${mprFocusFigure.manifest.figure.width_px} × ${mprFocusFigure.manifest.figure.height_px} · mpr-focus.loci-figure`,
  "focused-MPR export receipt");

  const wholeBeforeCollision = await bundleFingerprint(wholeFigurePath);
  await exportButton.click();
  const collisionError = page.locator(".raw-volume-export-error[role=alert]");
  await collisionError.waitFor({ state: "visible", timeout: 120_000 });
  assert.match(await collisionError.textContent(), /already exists at the volume figure destination/i);
  const wholeAfterCollision = await bundleFingerprint(wholeFigurePath);
  assert.deepEqual(wholeAfterCollision, wholeBeforeCollision,
    "A refused figure re-export modified the existing destination.");
  assert.equal(await sha256(fixturePath), fixtureSha256,
    "Volume figure publication or collision handling changed the source bytes.");
  assert.deepEqual(rendererFailures, { page_errors: [], console_errors: [] },
    "The packaged volume journey emitted an unhandled renderer failure.");
  captures.figureCollision = await screenshot("17-existing-figure-refused", viewport);
  const figureExports = {
    whole_volume: wholeFigure,
    mpr_focus: mprFocusFigure,
    collision: {
      attempted_destination: path.basename(wholeFigurePath),
      error: await collisionError.textContent(),
      existing_bundle_before: wholeBeforeCollision,
      existing_bundle_after: wholeAfterCollision,
      unmodified: true,
    },
  };
  const histogramQa = {
    binding: { source_id: sourceRecord.id, source_sha256: fixtureSha256, t: 0, level: 0 },
    component_semantics: ["synthetic-core", "synthetic-ring"],
    sample_count_per_component: 131_072,
    bins_per_component: 256,
    sample_basis: "deterministic equally spaced whole display volume; inclusive linear index v1",
    stable_across_pan_zoom: true,
    windows_before_trim: windowsBeforeTrim,
    windows_after_trim: windowsAfterTrim,
    source_sha256_after_trim: await sha256(fixturePath),
  };

  const rendererResources = await page.locator(".raw-volume-stage canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const memory = performance.memory;
    return {
      canvas_css: [canvas.clientWidth, canvas.clientHeight],
      drawing_buffer: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
      webgl_version: gl?.getParameter(gl.VERSION) ?? null,
      webgl_renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      js_heap_used_bytes: memory?.usedJSHeapSize ?? null,
      js_heap_total_bytes: memory?.totalJSHeapSize ?? null,
    };
  });
  const processResources = await app.evaluate(({ app: electronApp }) => ({
    metrics: electronApp.getAppMetrics(),
    system_memory: process.getSystemMemoryInfo(),
  }));
  const gpuMetric = processResources.metrics.find((item) => item.type === "GPU");
  const rendererMetric = processResources.metrics.find((item) => item.type === "Tab");
  assert.deepEqual(await Promise.all([sha256(executablePath), sha256(workerPath), sha256(applicationArtifact),
    sha256(path.join(desktopRoot, "src", "renderer", "RawVolumeViewport.tsx")), sha256(volumeSourcePath)]),
    [build.executable_sha256, build.worker_sha256, build.application_artifact_sha256,
      build.viewport_source_sha256, build.volume_source_sha256],
    "The qualified application artifacts changed during the journey.");
  assert.equal(await sha256(fixturePath), fixtureSha256, "Synthetic source bytes changed during viewing.");
  const snapshotAfter = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(snapshotAfter.sources.find((item) => item.id === sourceRecord.id)?.sha256, fixtureSha256,
    "Managed source identity changed during viewing.");
  captures.final = await screenshot("18-final-workbench");

  report = {
    schema: development ? "loci.image-first-volume-development-qa/v1" : "loci.image-first-volume-packaged-qa/v1",
    status: "passed",
    started_at: startedAt,
    elapsed_seconds: (performance.now() - journeyStart) / 1000,
    source,
    build,
    fixture: { path: fixturePath, sha256: fixtureSha256, axes: "CZYX", dimensions_xyz: [256, 192, 96],
      channels: 2, dtype: "uint16", spacing_xyz_um: [0.4, 0.8, 2.5], synthetic_non_biological: true },
    payloads: { coarse, refined, focused },
    histograms: histogramQa,
    figure_exports: figureExports,
    timing_ms: marks,
    loading_timing_ms: {
      cold_launch_ms: marks.cold_launch_ms,
      import_ms: marks.import_ms,
      initial_volume_ms: marks.initial_volume_ms,
      automatic_refinement_ms: marks.automatic_refinement_ms,
      focus_refinement_ms: marks.focus_refinement_ms,
    },
    interaction_timing_ms: {
      orbit_total_ms: marks.orbit_ms,
      pan_total_ms: marks.pan_ms,
      zoom_total_ms: marks.zoom_ms,
      animation_frames: frameTiming,
      workload: {
        phase: "full-resolution refined whole-context before focus sampling",
        context_dimensions_xyz: refined.contextDimensions.split("x").map(Number),
        context_bytes: refined.contextByteLength,
      },
      focus_sampling: {
        refinement_ms: marks.focus_refinement_ms,
        context_dimensions_xyz: focused.contextDimensions.split("x").map(Number),
        context_bytes: focused.contextByteLength,
        focus_extent_xyzxyz: focused.focusExtent.split(",").map(Number),
        focus_bytes: focused.focusByteLength,
        native_source_steps: focused.focusNativeSteps === "true",
      },
      budget: { platform: "Apple M1 / 8 GB", p95_ms: 50, p99_ms: 100 },
    },
    renderer_resources: {
      ...rendererResources,
      refined_pixels: refinedPixels,
      restored_pixels: restoredPixels,
      logical_scalar_texture_input_bytes: focused.contextByteLength + focused.focusByteLength,
      logical_scalar_texture_basis: "exact sum of simultaneously bound context and focus scalar payload bytes",
      dedicated_gpu_vram_bytes: null,
      dedicated_gpu_vram_status: "unavailable through WebGL/Electron; GPU process RSS is not dedicated VRAM",
      gpu_process_working_set_kb: gpuMetric?.memory?.workingSetSize ?? null,
      renderer_process_working_set_kb: rendererMetric?.memory?.workingSetSize ?? null,
    },
    process_resources: { ...processResources, sampled_launch_tree_rss: processTreeRss },
    hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
      logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem() },
    interactions: { keyboard_tooltip: true, mouse_tooltip: true, tooltip_dismiss_after_activation: true,
      keyboard_orbit_reset: true, orbit: true, pan: true, zoom: true, channel_visibility: true, channel_opacity: true,
      axis_clipping: true, mpr_xyz: true, focus_detail: true, webgl_context_loss_restore: true,
      native_histograms: true, histogram_sample_stable_across_navigation: true,
      percentile_trim_pointer_activation: true, percentile_trim_keyboard_activation: true,
      percentile_trim_display_only: true,
      whole_volume_figure_export: true, focused_mpr_figure_export: true, atomic_no_overwrite: true },
    renderer_failures: rendererFailures,
    captures,
    run_root: runRoot,
  };
  await fs.writeFile(path.join(runRoot, "qa-report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  await screenshot("failure").catch(() => undefined);
  await fs.writeFile(path.join(runRoot, "failed-run-evidence.json"), JSON.stringify({
    source, build, frameTiming, marks, captures, rendererFailures, error: String(error?.stack ?? error),
  }, null, 2) + "\n");
  await fs.writeFile(path.join(runRoot, "failure.txt"), String(error?.stack ?? error) + "\n");
  throw error;
} finally {
  if (rssSampler) await rssSampler.stop().catch(() => undefined);
  await close();
}
