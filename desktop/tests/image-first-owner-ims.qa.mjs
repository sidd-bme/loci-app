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
const expectedOwnerSha256 =
  "ec3f77df0c64ab69393e10ceae57e3d95346a1d8c772e055643be69793a2d940";
const ownerInput = process.env.LOCI_QA_OWNER_IMS;
if (!ownerInput || !path.isAbsolute(ownerInput))
  throw new Error("Set LOCI_QA_OWNER_IMS to the absolute path of the authorized owner IMS file.");
const ownerPath = path.normalize(ownerInput);
const ownerName = path.basename(ownerPath);
const volumeInput = process.env.LOCI_QA_OWNER_VOLUME;
if (volumeInput && !path.isAbsolute(volumeInput))
  throw new Error("LOCI_QA_OWNER_VOLUME must be an absolute path when supplied.");
const volumePath = volumeInput ? path.normalize(volumeInput) : null;
const volumeName = volumePath ? path.basename(volumePath) : null;
const expectedVolumeSha256 = process.env.LOCI_QA_OWNER_VOLUME_SHA256 ?? null;
if (expectedVolumeSha256 && !/^[a-f0-9]{64}$/u.test(expectedVolumeSha256))
  throw new Error("LOCI_QA_OWNER_VOLUME_SHA256 must be a lowercase SHA-256 digest.");

const packagedAppInput = process.env.LOCI_PACKAGED_APP ?? null;
if (packagedAppInput && !path.isAbsolute(packagedAppInput))
  throw new Error("LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
const packagedApp = packagedAppInput ? path.resolve(packagedAppInput) : null;
const development = process.env.LOCI_QA_DEV === "1";
if (Boolean(packagedApp) === development)
  throw new Error("Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The owner IMS journey currently qualifies Apple-silicon macOS.");

const qualificationRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ??
    path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/owner-ims"),
);
const relativeOutput = path.relative(projectRoot, qualificationRoot);
if (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== "..")
  throw new Error("LOCI_QA_OUTPUT_ROOT must remain outside the Git worktree.");
const runName = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const runRoot = path.join(qualificationRoot, runName);
const userData = path.join(runRoot, "user-data");
const screenshots = path.join(runRoot, "screenshots-private");
const l4Png = path.join(runRoot, "owner-l4-full-loci.png");
const l0Png = path.join(runRoot, "owner-l0-centre-loci.png");
const numericalScript = path.join(runRoot, "independent_owner_ims_compare.py");
const numericalReportPath = path.join(runRoot, "independent-owner-ims-comparison.json");
const volumeInspectionScript = path.join(runRoot, "independent_owner_volume_inspect.py");
const volumeInspectionReportPath = path.join(runRoot, "independent-owner-volume-inspection.json");

const executablePath = packagedApp
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
const workerPath = packagedApp
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const mainArtifact = packagedApp
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const independentPython = process.env.LOCI_QA_REFERENCE_PYTHON ??
  path.join(projectRoot, "engine", ".venv", "bin", "python");
if (!path.isAbsolute(independentPython))
  throw new Error("LOCI_QA_REFERENCE_PYTHON must be absolute when supplied.");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodeDataPng(value) {
  const prefix = "data:image/png;base64,";
  assert.ok(typeof value === "string" && value.startsWith(prefix),
    "The viewer did not return an inline PNG.");
  return Buffer.from(value.slice(prefix.length), "base64");
}

function safeError(value) {
  let text = String(value?.stack ?? value);
  for (const [privatePath, replacement] of [
    [ownerPath, "<owner-ims>"],
    [volumePath, "<owner-volume>"],
  ]) {
    if (privatePath) text = text.replaceAll(privatePath, replacement);
  }
  return text;
}

async function assertPlainFile(file, label) {
  const info = await fs.lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a plain file.`);
}

await Promise.all([
  assertPlainFile(ownerPath, "LOCI_QA_OWNER_IMS"),
  ...(volumePath ? [assertPlainFile(volumePath, "LOCI_QA_OWNER_VOLUME")] : []),
  fs.access(executablePath),
  fs.access(workerPath),
  fs.access(mainArtifact),
  fs.access(independentPython),
  fs.mkdir(userData, { recursive: true, mode: 0o700 }),
  fs.mkdir(screenshots, { recursive: true, mode: 0o700 }),
]);
await Promise.all([fs.chmod(runRoot, 0o700), fs.chmod(userData, 0o700), fs.chmod(screenshots, 0o700)]);
const realRunRoot = await fs.realpath(runRoot);
const realProjectRoot = await fs.realpath(projectRoot);
const realRelativeOutput = path.relative(realProjectRoot, realRunRoot);
if (!realRelativeOutput.startsWith(`..${path.sep}`) && realRelativeOutput !== "..")
  throw new Error("The resolved qualification directory is inside the Git worktree.");

const ownerSha256Before = await sha256(ownerPath);
assert.equal(ownerSha256Before, expectedOwnerSha256,
  "The authorized owner IMS does not match its fixed qualification fingerprint.");
const volumeSha256Before = volumePath ? await sha256(volumePath) : null;
if (expectedVolumeSha256)
  assert.equal(volumeSha256Before, expectedVolumeSha256,
    "The optional owner volume does not match LOCI_QA_OWNER_VOLUME_SHA256.");

const git = async (...args) =>
  (await run("git", args, { cwd: projectRoot })).stdout.trim();
const trackedSources = {
  workbench: path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx"),
  image_viewport: path.join(desktopRoot, "src", "renderer", "ImageViewport.tsx"),
  source_display: path.join(desktopRoot, "src", "renderer", "SourceDisplayPanel.tsx"),
  raw_volume_viewport: path.join(desktopRoot, "src", "renderer", "RawVolumeViewport.tsx"),
  navigation_qa_helper: path.join(import.meta.dirname, "navigation-performance-qa-helpers.mjs"),
  viewer_image: path.join(projectRoot, "engine", "src", "loci_engine", "viewer_image.py"),
  viewer_volume: path.join(projectRoot, "engine", "src", "loci_engine", "viewer_volume.py"),
  native_image: path.join(projectRoot, "engine", "src", "loci_engine", "native_image.py"),
};
const trackedSourceHashes = Object.fromEntries(await Promise.all(
  Object.entries(trackedSources).map(async ([name, file]) => [name, await sha256(file)]),
));
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  head_tree: await git("rev-parse", "HEAD^{tree}"),
  status: await git("status", "--porcelain"),
  harness_sha256: await sha256(import.meta.filename),
  files: trackedSourceHashes,
};
const buildIdentity = {
  mode: packagedApp ? "packaged-binary" : "forge-development",
  executable_sha256: await sha256(executablePath),
  worker_sha256: await sha256(workerPath),
  main_artifact_sha256: await sha256(mainArtifact),
  worker_mode: packagedApp ? "frozen-executable" : "python-module:loci_engine.worker",
};

await fs.writeFile(numericalScript, String.raw`import hashlib
import json
import sys
from pathlib import Path

import h5py
import numpy as np
from PIL import Image

source_path, level4_png, level0_png, report_path = map(Path, sys.argv[1:5])

def digest(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()

def observed(path):
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))

def attribute_text(value):
    if isinstance(value, np.ndarray):
        assert value.ndim == 1 and value.dtype == np.dtype("S1")
        value = value.tobytes()
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    assert isinstance(value, str)
    return value

with h5py.File(source_path, "r") as ims:
    assert attribute_text(ims.attrs["ImarisDataSet"]) == "ImarisDataSet"
    levels = sorted(
        (int(name.removeprefix("ResolutionLevel ")), name)
        for name in ims["DataSet"]
        if name.startswith("ResolutionLevel ")
    )
    assert [index for index, _ in levels] == list(range(5))

    def direct_rgb(level, x, y, width, height):
        root = ims[f"DataSet/ResolutionLevel {level}/TimePoint 0"]
        arrays = []
        for channel in range(3):
            channel_group = root[f"Channel {channel}"]
            dataset = channel_group["Data"]
            assert dataset.dtype == np.dtype(np.uint8)
            logical_shape = tuple(int(attribute_text(channel_group.attrs[f"ImageSize{axis}"])) for axis in "ZYX")
            assert logical_shape == {0: (1, 10121, 8998), 4: (1, 632, 562)}[level]
            # IMS allocates padded storage; the independent slice uses the
            # separately declared logical extent, never the padded border.
            assert dataset.shape == {0: (1, 10240, 9216), 4: (1, 1024, 1024)}[level]
            arrays.append(np.asarray(dataset[0, y:y + height, x:x + width]))
        return np.stack(arrays, axis=-1)

    expected_l4 = direct_rgb(4, 0, 0, 562, 632)
    expected_l0 = direct_rgb(0, 4371, 4932, 256, 256)

actual_l4 = observed(level4_png)
actual_l0 = observed(level0_png)
assert actual_l4.shape == expected_l4.shape == (632, 562, 3)
assert actual_l0.shape == expected_l0.shape == (256, 256, 3)
np.testing.assert_array_equal(actual_l4, expected_l4)
np.testing.assert_array_equal(actual_l0, expected_l0)
report = {
    "schema": "loci.owner-ims-independent-comparison/v1",
    "reader": "h5py direct IMS datasets plus Pillow PNG decode",
    "levels": 5,
    "dtype": "uint8",
    "comparisons": [
        {
            "level": 4,
            "selection_xywh": [0, 0, 562, 632],
            "shape_yxc": list(actual_l4.shape),
            "loci_rgb_sha256": digest(actual_l4),
            "direct_hdf5_rgb_sha256": digest(expected_l4),
            "maximum_absolute_delta": int(np.abs(actual_l4.astype(np.int16) - expected_l4.astype(np.int16)).max()),
        },
        {
            "level": 0,
            "selection_xywh": [4371, 4932, 256, 256],
            "shape_yxc": list(actual_l0.shape),
            "loci_rgb_sha256": digest(actual_l0),
            "direct_hdf5_rgb_sha256": digest(expected_l0),
            "maximum_absolute_delta": int(np.abs(actual_l0.astype(np.int16) - expected_l0.astype(np.int16)).max()),
        },
    ],
}
report_path.write_text(json.dumps(report, indent=2) + "\n")
`);
await fs.chmod(numericalScript, 0o600);

if (volumePath) {
  await fs.writeFile(volumeInspectionScript, String.raw`import json
import sys
from pathlib import Path

import h5py
import numpy as np

source_path, report_path = map(Path, sys.argv[1:3])
with h5py.File(source_path, "r") as ims:
    levels = sorted(int(name.removeprefix("ResolutionLevel ")) for name in ims["DataSet"] if name.startswith("ResolutionLevel "))
    assert levels == list(range(5))
    base = []
    coarse = []
    for channel in range(2):
        level0 = ims[f"DataSet/ResolutionLevel 0/TimePoint 0/Channel {channel}/Data"]
        level4 = ims[f"DataSet/ResolutionLevel 4/TimePoint 0/Channel {channel}/Data"]
        assert level0.shape == (96, 2048, 2048) and level0.dtype == np.dtype(np.uint16)
        assert level4.shape == (32, 128, 128) and level4.dtype == np.dtype(np.uint16)
        values = np.asarray(level4)
        summary = {
            "channel": channel,
            "shape_zyx": list(values.shape),
            "dtype": str(values.dtype),
            "nonzero_voxels": int(np.count_nonzero(values)),
            "minimum": int(values.min()),
            "maximum": int(values.max()),
            "distinct_values": int(np.unique(values).size),
        }
        assert summary["nonzero_voxels"] == 360448
        assert summary["maximum"] == [5967, 12877][channel]
        assert summary["distinct_values"] > 16
        coarse.append(summary)
        base.append({"channel": channel, "shape_zyx": list(level0.shape), "dtype": str(level0.dtype)})
report_path.write_text(json.dumps({
    "schema": "loci.owner-volume-independent-inspection/v1",
    "reader": "h5py direct IMS datasets",
    "levels": 5,
    "base": base,
    "coarse_level4": coarse,
}, indent=2) + "\n")
`);
  await fs.chmod(volumeInspectionScript, 0o600);
  await run(independentPython, [volumeInspectionScript, volumePath, volumeInspectionReportPath], {
    timeout: 180_000,
  });
  await fs.chmod(volumeInspectionReportPath, 0o600);
}

const startedAt = new Date().toISOString();
const journeyStarted = performance.now();
const timing = {};
const captures = {};
const pageErrors = [];
const consoleErrors = [];
const externalRequests = new Set();
const rendererResponseHashes = new Map();
const rendererResponseWork = [];
const processTreeRss = [];
let app;
let page;
let rssSampler;
let rssPhase;

function allowedDevelopmentRequest(value) {
  try {
    const url = new URL(value);
    return development && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port === "5173";
  } catch {
    return false;
  }
}

async function capture(name, locator = page) {
  const destination = path.join(screenshots, `${name}.png`);
  const bytes = await locator.screenshot({ path: destination });
  assert.ok(bytes.length > 2_000, `${name} was not a substantive private capture.`);
  await fs.chmod(destination, 0o600);
  const value = { file: path.basename(destination), sha256: hashBytes(bytes), bytes: bytes.length };
  captures[name] = value;
  return value;
}

async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
}

async function waitFor(check, label, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await noUiError(label);
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(80);
  }
  await noUiError(label);
  throw new Error(`Timed out waiting for ${label}.`);
}

async function launch() {
  const before = performance.now();
  const instance = await electron.launch({
    executablePath,
    args: [...(development ? [desktopRoot] : []), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  rssPhase = "owner-ims-2d";
  rssSampler = await startProcessTreeRssSampler(instance.process().pid, {
    intervalMs: 200,
    workerCommandIncludes: packagedApp ? workerPath : "-m loci_engine.worker",
  });
  const window = await instance.firstWindow();
  window.setDefaultTimeout(30_000);
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  window.on("request", (request) => {
    if (/^https?:/iu.test(request.url()) && !allowedDevelopmentRequest(request.url()))
      externalRequests.add(request.url());
  });
  window.on("websocket", (socket) => {
    if (/^wss?:/iu.test(socket.url()) && !allowedDevelopmentRequest(socket.url()))
      externalRequests.add(socket.url());
  });
  if (development) window.on("response", (response) => {
    if (!allowedDevelopmentRequest(response.url())) return;
    const work = response.body().then((bytes) => {
      const url = new URL(response.url());
      rendererResponseHashes.set(url.pathname, hashBytes(bytes));
    }).catch(() => undefined);
    rendererResponseWork.push(work);
  });
  await instance.evaluate(({ app: electronApp, BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    mainWindow?.setBounds({ width: 1440, height: 960 });
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.moveTop();
    electronApp.focus({ steal: true });
  });
  await window.getByRole("main", { name: "Loci workspace" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  timing.cold_launch_ms = performance.now() - before;
  return { instance, window };
}

async function installDialogs(sources) {
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images")
        return { canceled: false, filePaths: values.sources };
      throw new Error(`Unexpected owner qualification open picker: ${options?.title}`);
    };
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      throw new Error(`Unexpected owner qualification save picker: ${options?.title}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources });
}

async function stopRssSampling() {
  if (!rssSampler) return;
  const activeSampler = rssSampler;
  const phase = rssPhase;
  rssSampler = undefined;
  rssPhase = undefined;
  processTreeRss.push({ phase, ...await activeSampler.stop() });
}

async function close() {
  if (!app) return;
  await stopRssSampling().catch(() => undefined);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await closed;
  app = undefined;
  page = undefined;
}

async function sourceButton(name) {
  const button = page.locator(".research-sources").getByRole("button", {
    name: new RegExp(`^${escapeRegExp(name)}`),
  });
  await button.waitFor({ state: "visible", timeout: 600_000 });
  return button;
}

async function waitForViewer(name, expectedLevel = null) {
  const viewer = page.getByLabel(`Image viewer: ${name}`);
  await viewer.waitFor({ state: "visible", timeout: 600_000 });
  await page.waitForFunction(({ sourceName, level }) => {
    const element = [...document.querySelectorAll(".image-viewport")].find(
      (item) => item.getAttribute("aria-label") === `Image viewer: ${sourceName}`,
    );
    return Boolean(element) && Number(element.getAttribute("data-cache-bytes")) > 0 &&
      !element.querySelector(".image-view-loading") &&
      (level === null || Number(element.getAttribute("data-auto-level")) === level);
  }, { sourceName: name, level: expectedLevel }, { timeout: 600_000 });
  await noUiError(`loading ${name}`);
  return viewer;
}

async function currentSourceView(sourceId) {
  return page.evaluate((id) => window.lociResearch.execute("source_view", { source_id: id }), sourceId);
}

async function waitForSavedSourceView(sourceId, accept, label) {
  return waitFor(async () => {
    const value = await currentSourceView(sourceId);
    return accept(value) ? value : null;
  }, label, 30_000);
}

function imageAspect(metadata) {
  const affine = metadata.geometry?.affine;
  let sx;
  let sy;
  if (Array.isArray(affine) && affine.length >= 3) {
    sx = Math.hypot(...affine.slice(0, 3).map((row) => row[0]));
    sy = Math.hypot(...affine.slice(0, 3).map((row) => row[1]));
  } else {
    sx = metadata.physical_calibration?.spacing?.at(-1);
    sy = metadata.physical_calibration?.spacing?.at(-2);
  }
  return sx > 0 && sy > 0 ? sy / sx : 1;
}

async function fittedGeometry(viewer, metadata) {
  const state = await viewer.evaluate((element) => ({
    camera: JSON.parse(element.getAttribute("data-camera")),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    device_pixel_ratio: window.devicePixelRatio,
    automatic_level: Number(element.getAttribute("data-auto-level")),
  }));
  const width = metadata.dimensions.x;
  const height = metadata.dimensions.y;
  const aspectY = imageAspect(metadata);
  const left = state.width / 2 - state.camera.x * state.camera.scale;
  const right = state.width / 2 + (width - state.camera.x) * state.camera.scale;
  const top = state.height / 2 - state.camera.y * state.camera.scale * aspectY;
  const bottom = state.height / 2 + (height - state.camera.y) * state.camera.scale * aspectY;
  assert.ok(left >= -1 && top >= -1 && right <= state.width + 1 && bottom <= state.height + 1,
    "Fit did not retain every source edge inside the viewport.");
  assert.ok(right - left > 0.5 * state.width || bottom - top > 0.5 * state.height,
    "Fit left the source implausibly small inside the viewport.");
  const fitLevel = metadata.levels.filter((level) => Math.max(width / level.dimensions.x,
    height / level.dimensions.y * aspectY) * state.camera.scale * Math.max(1, state.device_pixel_ratio) <= 1.25).at(-1)?.index ?? 0;
  assert.equal(state.automatic_level, fitLevel,
    "Fit must choose the pyramid detail appropriate to the actual high-DPI viewport.");
  return { ...state, aspect_y: aspectY, source_edges_css: { left, right, top, bottom } };
}

async function canvasCapture(name) {
  const canvas = page.locator(".raw-volume-stage canvas");
  await canvas.waitFor({ state: "visible", timeout: 600_000 });
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const destination = path.join(screenshots, `${name}.png`);
  const bytes = await canvas.screenshot({ path: destination });
  await fs.chmod(destination, 0o600);
  const pixels = await app.evaluate(({ nativeImage }, encoded) => {
    const image = nativeImage.createFromBuffer(Buffer.from(encoded, "base64")).resize({
      width: 256,
      quality: "best",
    });
    const bitmap = image.toBitmap();
    let bright = 0;
    let nonBackground = 0;
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      const value = (bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3;
      if (Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]) >= 48) bright += 1;
      if (Math.abs(value - 21) > 8) nonBackground += 1;
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
    const mean = sum / count;
    return {
      width: image.getSize().width,
      height: image.getSize().height,
      bright_pixels: bright,
      non_background_pixels: nonBackground,
      luminance_mean: mean,
      luminance_standard_deviation: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
    };
  }, bytes.toString("base64"));
  const value = { file: path.basename(destination), sha256: hashBytes(bytes), bytes: bytes.length,
    pixel_stats: pixels };
  captures[name] = value;
  return value;
}

async function volumeState() {
  return page.locator(".raw-volume").evaluate((element) => ({
    source_id: element.getAttribute("data-source-id"),
    source_sha256: element.getAttribute("data-source-sha256"),
    context_dimensions_xyz: element.getAttribute("data-context-dimensions"),
    context_byte_length: Number(element.getAttribute("data-context-byte-length")),
    context_level: Number(element.getAttribute("data-context-level")),
    transfer_ranges: element.getAttribute("data-transfer-ranges"),
    transfer_range_basis: element.getAttribute("data-transfer-range-basis"),
    status: element.querySelector(".raw-volume-status")?.textContent ?? "",
  }));
}

let numericalComparison;
let volumeInspection = null;
let ownerSource;
let volumeSource = null;
let fitted;
let nativeCamera;
let edgeCameras;
let defaults;
let initialSourceView;
let resetSourceView;
let overriddenSourceView;
let restoredSourceView;
let informationObservation;
let volumeEvidence = null;
let rendererExposure;

try {
  ({ instance: app, window: page } = await launch());
  await installDialogs([ownerPath]);
  const importStarted = performance.now();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 600_000,
  });
  await sourceButton(ownerName);
  const ownerViewer = await waitForViewer(ownerName);
  timing.import_to_owner_fit_ms = performance.now() - importStarted;

  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  ownerSource = snapshot.sources.find((item) => item.name === ownerName);
  assert.ok(ownerSource, "The authorized owner IMS is absent from the managed snapshot.");
  assert.equal(ownerSource.sha256, expectedOwnerSha256);
  assert.equal(ownerSource.source_kind, "native");
  assert.equal(ownerSource.metadata.format, "IMS");
  assert.equal(ownerSource.metadata.source_axes, "TCZYX");
  assert.deepEqual(ownerSource.metadata.source_shape, [1, 3, 1, 10121, 8998]);
  assert.deepEqual(ownerSource.metadata.dimensions,
    { t: 1, c: 3, z: 1, y: 10121, x: 8998, s: 1 });
  assert.deepEqual(ownerSource.metadata.channel_dtypes, ["uint8", "uint8", "uint8"]);
  assert.equal(ownerSource.metadata.sample_semantics, "none");
  assert.equal(ownerSource.metadata.levels.length, 5);
  assert.deepEqual(ownerSource.metadata.levels.map((level) => level.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(ownerSource.metadata.levels[0].dimensions,
    { t: 1, c: 3, z: 1, y: 10121, x: 8998, s: 1 });
  assert.deepEqual(ownerSource.metadata.levels[4].dimensions,
    { t: 1, c: 3, z: 1, y: 632, x: 562, s: 1 });
  assert.equal(snapshot.sources.length, 1,
    "The owner IMS must be qualified alone during its first-view resource phase.");

  ({ defaults, sourceView: initialSourceView } = await page.evaluate(async (sourceId) => {
    const observedDefaults = await window.lociResearch.execute("viewer_defaults", {
      source_id: sourceId,
      t: 0,
      z: 0,
      auto: false,
    });
    const sourceView = await window.lociResearch.execute("source_view", { source_id: sourceId });
    return { defaults: observedDefaults, sourceView };
  }, ownerSource.id));
  const expectedChannels = [
    { channel: 0, low: 0, high: 255, gamma: 1, color: "#ff0000", opacity: 1, visible: true },
    { channel: 1, low: 0, high: 255, gamma: 1, color: "#00ff00", opacity: 1, visible: true },
    { channel: 2, low: 0, high: 255, gamma: 1, color: "#0000ff", opacity: 1, visible: true },
  ];
  assert.equal(defaults.source_id, ownerSource.id);
  assert.equal(defaults.source_sha256, expectedOwnerSha256);
  assert.equal(defaults.basis.mode, "acquisition");
  assert.equal(defaults.basis.viewport_dependent, false);
  assert.deepEqual(defaults.channels, expectedChannels);
  assert.equal(initialSourceView.source_id, ownerSource.id);
  assert.equal(initialSourceView.source_sha256, expectedOwnerSha256);

  const fitStarted = performance.now();
  await ownerViewer.locator(".image-view-tools").getByRole("button", { name: "Fit image" }).click();
  await waitForViewer(ownerName);
  timing.explicit_fit_ms = performance.now() - fitStarted;
  fitted = await fittedGeometry(ownerViewer, ownerSource.metadata);
  captures.owner_fit = await capture("01-owner-fit", ownerViewer);

  const tileStarted = performance.now();
  const tiles = await page.evaluate(async ({ sourceId, channels }) => {
    const l4Selection = { x: 0, y: 0, width: 562, height: 632, z: 0, t: 0, c: 0, level: 4 };
    const l0Selection = { x: 4371, y: 4932, width: 256, height: 256, z: 0, t: 0, c: 0, level: 0 };
    const l4 = await window.lociResearch.execute("viewer_tile", {
      source_id: sourceId,
      selection: l4Selection,
      channels,
    });
    const l0 = await window.lociResearch.execute("viewer_tile", {
      source_id: sourceId,
      selection: l0Selection,
      channels,
    });
    return { l4, l0, l4Selection, l0Selection };
  }, { sourceId: ownerSource.id, channels: defaults.channels });
  timing.two_exact_viewer_tiles_ms = performance.now() - tileStarted;
  assert.equal(tiles.l4.source_sha256, expectedOwnerSha256);
  assert.equal(tiles.l0.source_sha256, expectedOwnerSha256);
  assert.deepEqual(tiles.l4.selection, tiles.l4Selection);
  assert.deepEqual(tiles.l0.selection, tiles.l0Selection);
  assert.deepEqual(tiles.l4.display, defaults.channels);
  assert.deepEqual(tiles.l0.display, defaults.channels);
  assert.equal(tiles.l4.display_revision, tiles.l0.display_revision);
  await Promise.all([
    fs.writeFile(l4Png, decodeDataPng(tiles.l4.image), { mode: 0o600 }),
    fs.writeFile(l0Png, decodeDataPng(tiles.l0.image), { mode: 0o600 }),
  ]);
  await run(independentPython, [numericalScript, ownerPath, l4Png, l0Png, numericalReportPath], {
    timeout: 180_000,
  });
  await fs.chmod(numericalReportPath, 0o600);
  numericalComparison = JSON.parse(await fs.readFile(numericalReportPath, "utf8"));
  assert.deepEqual(numericalComparison.comparisons.map((item) => item.maximum_absolute_delta), [0, 0]);

  const nativeStarted = performance.now();
  await ownerViewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  await waitForViewer(ownerName, 0);
  const nativeZoom = page.getByLabel("Native pixel zoom").filter({ visible: true });
  await nativeZoom.waitFor({ state: "visible" });
  assert.equal(await nativeZoom.textContent(), "100%");
  timing.native_one_to_one_ms = performance.now() - nativeStarted;
  nativeCamera = JSON.parse(await ownerViewer.getAttribute("data-camera"));
  captures.owner_native = await capture("02-owner-native", ownerViewer);
  assert.notEqual(captures.owner_native.sha256, captures.owner_fit.sha256);

  const navigator = ownerViewer.getByRole("button", { name: "Overview navigator" });
  await navigator.waitFor({ state: "visible" });
  await navigator.scrollIntoViewIfNeeded();
  const topLeftNavigatorBounds = await navigator.boundingBox();
  assert.ok(topLeftNavigatorBounds, "The full-source navigator has no usable bounds.");
  await page.mouse.click(topLeftNavigatorBounds.x + 1.5, topLeftNavigatorBounds.y + 1.5);
  const topLeft = await waitFor(async () => {
    const camera = JSON.parse(await ownerViewer.getAttribute("data-camera"));
    return camera.x < 0.02 * 8998 && camera.y < 0.02 * 10121 ? camera : null;
  }, "native top-left source edge");
  await waitForViewer(ownerName, 0);
  captures.owner_top_left = await capture("03-owner-native-top-left", ownerViewer);
  await navigator.scrollIntoViewIfNeeded();
  const bottomRightNavigatorBounds = await navigator.boundingBox();
  assert.ok(bottomRightNavigatorBounds, "The full-source navigator has no usable bounds.");
  await page.mouse.click(
    bottomRightNavigatorBounds.x + bottomRightNavigatorBounds.width - 1.5,
    bottomRightNavigatorBounds.y + bottomRightNavigatorBounds.height - 1.5,
  );
  const bottomRight = await waitFor(async () => {
    const camera = JSON.parse(await ownerViewer.getAttribute("data-camera"));
    return camera.x > 0.98 * 8998 && camera.y > 0.98 * 10121 ? camera : null;
  }, "native bottom-right source edge");
  await waitForViewer(ownerName, 0);
  captures.owner_bottom_right = await capture("04-owner-native-bottom-right", ownerViewer);
  edgeCameras = { top_left: topLeft, bottom_right: bottomRight };

  await navigator.scrollIntoViewIfNeeded();
  const centreNavigatorBounds = await navigator.boundingBox();
  assert.ok(centreNavigatorBounds, "The full-source navigator has no usable bounds.");
  await page.mouse.click(
    centreNavigatorBounds.x + centreNavigatorBounds.width / 2,
    centreNavigatorBounds.y + centreNavigatorBounds.height / 2,
  );
  await waitForViewer(ownerName, 0);
  const navigationCanvas = ownerViewer.getByLabel("Source image and bound annotations");
  const navigationBounds = await navigationCanvas.boundingBox();
  assert.ok(navigationBounds && navigationBounds.width > 300 && navigationBounds.height > 250,
    "The owner 2D viewer is not usable at the qualification window size.");
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
  await waitForViewer(ownerName, 0);
  const warmedPanCacheBytes = Number(await ownerViewer.getAttribute("data-cache-bytes"));
  const cameraBeforeMeasuredPan = await ownerViewer.getAttribute("data-camera");
  timing.cached_pan_animation_frames = await measureRafDuring(
    page,
    "sustained cached owner IMS 2D pan",
    () => dragPan(-180, -104),
  );
  await waitForViewer(ownerName, 0);
  assert.notEqual(await ownerViewer.getAttribute("data-camera"), cameraBeforeMeasuredPan,
    "The sustained cached owner IMS pan did not move the 2D camera.");
  assert.equal(Number(await ownerViewer.getAttribute("data-cache-bytes")), warmedPanCacheBytes,
    "The measured owner IMS pan left the warmed tile-cache path.");
  assert.ok(timing.cached_pan_animation_frames.p95_ms <= 33.4,
    `Cached owner IMS pan p95 exceeded 33.4 ms: ${timing.cached_pan_animation_frames.p95_ms}`);
  assert.ok(timing.cached_pan_animation_frames.p99_ms <= 50,
    `Cached owner IMS pan p99 exceeded 50 ms: ${timing.cached_pan_animation_frames.p99_ms}`);

  const wheelZoom = async (events) => {
    await page.mouse.move(navigationCenter.x, navigationCenter.y);
    for (let index = 0; index < events; index += 1) {
      await page.mouse.wheel(0, index % 2 === 0 ? -50 : 50);
      await page.waitForTimeout(20);
    }
  };
  await wheelZoom(48);
  await waitForViewer(ownerName, 0);
  const warmedWheelCacheBytes = Number(await ownerViewer.getAttribute("data-cache-bytes"));
  const cameraBeforeMeasuredWheel = await ownerViewer.getAttribute("data-camera");
  timing.cached_wheel_zoom_animation_frames = await measureRafDuring(
    page,
    "sustained cached owner IMS 2D wheel zoom",
    () => wheelZoom(47),
  );
  await waitForViewer(ownerName);
  assert.notEqual(await ownerViewer.getAttribute("data-camera"), cameraBeforeMeasuredWheel,
    "The sustained cached owner IMS wheel zoom did not change the 2D camera.");
  assert.equal(Number(await ownerViewer.getAttribute("data-cache-bytes")), warmedWheelCacheBytes,
    "The measured owner IMS wheel zoom left the warmed tile-cache path.");
  assert.ok(timing.cached_wheel_zoom_animation_frames.p95_ms <= 33.4,
    `Cached owner IMS wheel zoom p95 exceeded 33.4 ms: ${timing.cached_wheel_zoom_animation_frames.p95_ms}`);
  assert.ok(timing.cached_wheel_zoom_animation_frames.p99_ms <= 50,
    `Cached owner IMS wheel zoom p99 exceeded 50 ms: ${timing.cached_wheel_zoom_animation_frames.p99_ms}`);
  await ownerViewer.locator(".image-view-tools").getByRole("button", { name: "Fit image" }).click();
  await waitForViewer(ownerName, 4);

  const displayPanel = page.locator(".source-display");
  const information = displayPanel.locator("details.source-information");
  const informationSummary = information.locator(":scope > summary");
  await informationSummary.click();
  await page.getByRole("button", { name: "Close image information", exact: true }).waitFor();
  informationObservation = {
    text: await information.locator(".source-information-content").innerText(),
    open_as: await page.getByLabel("Open as").inputValue(),
    recorded_calibration: ownerSource.metadata.physical_calibration ?? null,
    recorded_geometry: ownerSource.metadata.geometry ?? null,
  };
  assert.match(informationObservation.text, /8,998 × 10,121/u);
  assert.match(informationObservation.text, /3 scalar channels/u);
  assert.match(informationObservation.text, /1 Z · 1 T/u);
  captures.owner_information = await capture("05-owner-image-information", page.locator(".research-inspector"));
  await page.getByRole("button", { name: "Close image information", exact: true }).click();
  assert.equal(await information.getAttribute("open"), null);
  assert.equal(await informationSummary.evaluate((element) => document.activeElement === element), true);
  await informationSummary.click();
  await informationSummary.focus();
  await informationSummary.press("Escape");
  assert.equal(await information.getAttribute("open"), null);
  assert.equal(await informationSummary.evaluate((element) => document.activeElement === element), true);
  await ownerViewer.locator(".image-view-tools").getByRole("button", { name: "Fit image" }).click();
  await waitForViewer(ownerName, 4);

  const firstChannel = displayPanel.locator("details.source-channel").nth(0);
  const secondChannel = displayPanel.locator("details.source-channel").nth(1);
  if (!(await firstChannel.getAttribute("open"))) await firstChannel.locator(":scope > summary").click();
  await page.getByLabel("Channel 1 low", { exact: true }).fill("17");
  await page.getByLabel("Channel 1 low", { exact: true }).press("Enter");
  await page.getByLabel("Channel 2 visible", { exact: true }).uncheck();
  await waitForViewer(ownerName, 4);
  captures.owner_channels_changed = await capture("06-owner-channels-changed", ownerViewer);
  assert.notEqual(captures.owner_channels_changed.sha256, captures.owner_fit.sha256);
  await displayPanel.locator(".source-channel-heading").getByRole("button", { name: "Reset", exact: true }).click();
  await waitForViewer(ownerName, 4);
  assert.equal(await page.getByLabel("Channel 1 low", { exact: true }).inputValue(), "0");
  assert.equal(await page.getByLabel("Channel 2 visible", { exact: true }).isChecked(), true);
  resetSourceView = await waitForSavedSourceView(ownerSource.id,
    (value) => value.state?.channels && JSON.stringify(value.state.channels) === JSON.stringify(defaults.channels),
    "source-bound channel reset persistence");

  await informationSummary.click();
  await page.getByLabel("Red plane", { exact: true }).selectOption("2");
  await page.getByLabel("Green plane", { exact: true }).selectOption("1");
  await page.getByLabel("Blue plane", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "Apply RGB mapping", exact: true }).click();
  await waitForViewer(ownerName, 4);
  await page.getByRole("button", { name: "Restore source composite", exact: true }).waitFor();
  overriddenSourceView = await waitForSavedSourceView(ownerSource.id,
    (value) => JSON.stringify(value.state?.rgb_mapping) === JSON.stringify([2, 1, 0]),
    "declared RGB plane override persistence");
  assert.deepEqual(overriddenSourceView.state.channels, [
    { ...expectedChannels[0], color: "#0000ff" },
    expectedChannels[1],
    { ...expectedChannels[2], color: "#ff0000" },
  ]);
  captures.owner_rgb_override = await capture("07-owner-rgb-plane-override", ownerViewer);
  assert.notEqual(captures.owner_rgb_override.sha256, captures.owner_fit.sha256);
  await page.getByRole("button", { name: "Restore source composite", exact: true }).click();
  await waitForViewer(ownerName, 4);
  await page.getByRole("button", { name: "Restore source composite", exact: true }).waitFor({ state: "detached" });
  restoredSourceView = await waitForSavedSourceView(ownerSource.id,
    (value) => value.state?.rgb_mapping === null &&
      JSON.stringify(value.state.channels) === JSON.stringify(defaults.channels),
    "source composite restoration persistence");
  captures.owner_rgb_restored = await capture("08-owner-source-composite-restored", ownerViewer);
  await page.getByRole("button", { name: "Close image information", exact: true }).click();
  await noUiError("owner IMS 2D journey");

  await stopRssSampling();

  if (volumePath && volumeName) {
    await installDialogs([volumePath]);
    rssPhase = "optional-owner-volume";
    rssSampler = await startProcessTreeRssSampler(app.process().pid, {
      intervalMs: 200,
      workerCommandIncludes: packagedApp ? workerPath : "-m loci_engine.worker",
    });
    const volumeStarted = performance.now();
    await page.getByRole("button", { name: "Open images", exact: true }).click();
    const volumeButton = await sourceButton(volumeName);
    await volumeButton.click();
    await waitForViewer(volumeName);
    const volumeSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    volumeSource = volumeSnapshot.sources.find((item) => item.name === volumeName) ?? null;
    assert.ok(volumeSource, "The optional owner volume is absent after its explicit second import.");
    assert.equal(volumeSource.sha256, volumeSha256Before);
    assert.equal(volumeSource.metadata.format, "IMS");
    assert.equal(volumeSource.metadata.source_axes, "TCZYX");
    assert.deepEqual(volumeSource.metadata.source_shape, [1, 2, 96, 2048, 2048]);
    assert.deepEqual(volumeSource.metadata.dimensions,
      { t: 1, c: 2, z: 96, y: 2048, x: 2048, s: 1 });
    assert.deepEqual(volumeSource.metadata.channel_dtypes, ["uint16", "uint16"]);
    assert.equal(volumeSource.metadata.levels.length, 5);
    assert.deepEqual(volumeSource.metadata.levels[4].dimensions,
      { t: 1, c: 2, z: 32, y: 128, x: 128, s: 1 });
    const secondVisible = page.getByLabel("Channel 2 visible", { exact: true });
    await secondVisible.waitFor({ state: "visible", timeout: 600_000 });
    if (!(await secondVisible.isChecked())) await secondVisible.check();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "3D volume", exact: true }).click();
    const rawVolume = page.locator(".raw-volume");
    await rawVolume.waitFor({ state: "visible", timeout: 600_000 });
    const coarse = await waitFor(async () => {
      const state = await volumeState();
      return state.context_dimensions_xyz === "128x128x32" &&
        state.context_level === 4 && state.status.includes("display") ? state : null;
    }, "the owner volume native level-4 context", 600_000);
    timing.owner_volume_first_display_ms = performance.now() - volumeStarted;
    assert.equal(coarse.source_id, volumeSource.id);
    assert.equal(coarse.source_sha256, volumeSha256Before);
    assert.equal(coarse.context_byte_length, 128 * 128 * 32 * 2 * 2);
    const coarseCapture = await canvasCapture("09-owner-volume-coarse");
    assert.ok(coarseCapture.pixel_stats.non_background_pixels > 1_000);
    assert.ok(coarseCapture.pixel_stats.bright_pixels > 500);
    assert.ok(coarseCapture.pixel_stats.luminance_standard_deviation > 3);

    const settled = await waitFor(async () => {
      const before = await volumeState();
      if (!before.status.includes("display")) return null;
      await page.waitForTimeout(900);
      const after = await volumeState();
      return before.context_dimensions_xyz === after.context_dimensions_xyz &&
        before.context_level === after.context_level && after.status.includes("display") ? after : null;
    }, "a settled owner volume refinement", 600_000);
    const settledCapture = await canvasCapture("10-owner-volume-settled");
    assert.ok(settledCapture.pixel_stats.non_background_pixels > 1_000);
    assert.ok(settledCapture.pixel_stats.luminance_standard_deviation > 3);

    const stage = page.locator(".raw-volume-stage");
    const stageBounds = await stage.boundingBox();
    assert.ok(stageBounds && stageBounds.width > 300 && stageBounds.height > 250,
      "The owner volume viewport is not usable at the qualification window size.");
    const centre = { x: stageBounds.x + stageBounds.width / 2, y: stageBounds.y + stageBounds.height / 2 };
    await stage.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const orbit = await canvasCapture("11-owner-volume-keyboard-orbit");
    assert.notEqual(orbit.sha256, settledCapture.sha256, "Keyboard orbit did not change the owner volume.");
    await page.keyboard.press("r");
    await page.waitForTimeout(150);
    const reset = await canvasCapture("12-owner-volume-camera-reset");
    assert.equal(reset.sha256, settledCapture.sha256,
      "Camera reset did not restore the source-bound initial owner volume view.");

    await page.mouse.move(centre.x - 45, centre.y - 20);
    await page.mouse.down({ button: "left" });
    await page.mouse.move(centre.x + 65, centre.y + 35, { steps: 12 });
    await page.mouse.up({ button: "left" });
    await page.waitForTimeout(150);
    const mouseOrbit = await canvasCapture("13-owner-volume-mouse-orbit");
    assert.notEqual(mouseOrbit.sha256, reset.sha256, "Mouse orbit did not change the owner volume.");
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(centre.x + 50, centre.y - 30, { steps: 10 });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(150);
    const pan = await canvasCapture("14-owner-volume-right-pan");
    assert.notEqual(pan.sha256, mouseOrbit.sha256, "Right-drag pan did not change the owner volume.");
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(150);
    const zoom = await canvasCapture("15-owner-volume-zoom");
    assert.notEqual(zoom.sha256, pan.sha256, "Scroll zoom did not change the owner volume.");

    const firstVolumeChannel = page.locator("details.raw-volume-channel").first();
    const firstVisible = firstVolumeChannel.locator('input[type="checkbox"]');
    if (!(await firstVisible.isChecked())) await firstVisible.check();
    await page.waitForTimeout(120);
    const transferBefore = await canvasCapture("16-owner-volume-transfer-before");
    await firstVisible.uncheck();
    await page.waitForTimeout(120);
    const transferHidden = await canvasCapture("17-owner-volume-transfer-hidden");
    assert.notEqual(transferHidden.sha256, transferBefore.sha256,
      "Volume channel visibility did not change the rendered owner volume.");
    await firstVisible.check();
    if (!(await firstVolumeChannel.getAttribute("open")))
      await firstVolumeChannel.locator(":scope > summary").click();
    const opacity = firstVolumeChannel.getByLabel(/ opacity$/u);
    await opacity.fill("0.35");
    await page.waitForTimeout(120);
    const transferOpacity = await canvasCapture("18-owner-volume-transfer-opacity");
    assert.notEqual(transferOpacity.sha256, transferHidden.sha256,
      "Volume opacity did not change the rendered owner volume.");
    await firstVolumeChannel.getByRole("button", { name: "Reset channel", exact: true }).click();

    await page.getByRole("button", { name: "MPR", exact: true }).click();
    for (const axis of ["X", "Y", "Z"]) {
      const slider = page.getByLabel(`${axis} slice`, { exact: true });
      const maximum = Number(await slider.getAttribute("max"));
      await slider.fill(String(Math.floor(maximum * 0.6)));
    }
    await page.waitForTimeout(150);
    const mpr = await canvasCapture("19-owner-volume-mpr");
    assert.notEqual(mpr.sha256, transferOpacity.sha256, "MPR did not change the owner volume view.");
    assert.ok(mpr.pixel_stats.non_background_pixels > 1_000);
    assert.ok(mpr.pixel_stats.luminance_standard_deviation > 3);
    volumeEvidence = {
      coarse,
      settled,
      independent_level4: JSON.parse(await fs.readFile(volumeInspectionReportPath, "utf8")),
      interactions: {
        substantive_volume_canvas: true,
        keyboard_orbit_and_reset: true,
        mouse_orbit: true,
        right_drag_pan: true,
        scroll_zoom: true,
        channel_visibility_and_opacity: true,
        mpr_crosshair: true,
      },
    };
    volumeInspection = volumeEvidence.independent_level4;
    await noUiError("optional owner volume journey");
    await stopRssSampling();
  }

  rendererExposure = await page.evaluate(({ ownerAbsolute, ownerDirectory, ownerFilename,
    volumeAbsolute, volumeDirectory, volumeFilename }) => {
    const snapshot = document.documentElement.outerHTML;
    const visible = document.body.innerText;
    const local = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]));
    const session = Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]));
    const captured = JSON.stringify({ snapshot, visible, local, session });
    return {
      owner_full_path_present: captured.includes(ownerAbsolute),
      owner_directory_present: captured.includes(ownerDirectory),
      owner_filename_present: captured.includes(ownerFilename),
      volume_full_path_present: volumeAbsolute ? captured.includes(volumeAbsolute) : false,
      volume_directory_present: volumeDirectory ? captured.includes(volumeDirectory) : false,
      volume_filename_present: volumeFilename ? captured.includes(volumeFilename) : false,
    };
  }, {
    ownerAbsolute: ownerPath,
    ownerDirectory: path.dirname(ownerPath),
    ownerFilename: ownerName,
    volumeAbsolute: volumePath,
    volumeDirectory: volumePath ? path.dirname(volumePath) : null,
    volumeFilename: volumeName,
  });
  assert.equal(rendererExposure.owner_full_path_present, false);
  assert.equal(rendererExposure.owner_directory_present, false);
  assert.equal(rendererExposure.owner_filename_present, true);
  assert.equal(rendererExposure.volume_full_path_present, false);
  assert.equal(rendererExposure.volume_directory_present, false);
  if (volumeName) assert.equal(rendererExposure.volume_filename_present, true);

  const resourceUrls = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name).filter((name) => /^https?:/iu.test(name)));
  for (const url of resourceUrls) if (!allowedDevelopmentRequest(url)) externalRequests.add(url);
  await Promise.all(rendererResponseWork);
  assert.deepEqual([...externalRequests], [], "The owner qualification made an external request.");
  assert.deepEqual(pageErrors, [], "The owner qualification emitted renderer page errors.");
  assert.deepEqual(consoleErrors, [], "The owner qualification emitted renderer console errors.");

  const ownerSha256After = await sha256(ownerPath);
  assert.equal(ownerSha256After, ownerSha256Before, "The owner IMS bytes changed during viewing.");
  const volumeSha256After = volumePath ? await sha256(volumePath) : null;
  assert.equal(volumeSha256After, volumeSha256Before, "The owner volume bytes changed during viewing.");
  const finalBuildIdentity = {
    mode: buildIdentity.mode,
    executable_sha256: await sha256(executablePath),
    worker_sha256: await sha256(workerPath),
    main_artifact_sha256: await sha256(mainArtifact),
    worker_mode: buildIdentity.worker_mode,
  };
  assert.deepEqual(finalBuildIdentity, buildIdentity,
    "The qualified application or worker artifact changed during the journey.");
  assert.equal(await sha256(import.meta.filename), sourceIdentity.harness_sha256,
    "The qualification harness changed while running.");
  assert.deepEqual(Object.fromEntries(await Promise.all(
    Object.entries(trackedSources).map(async ([name, file]) => [name, await sha256(file)]),
  )), trackedSourceHashes, "A qualified source module changed during the journey.");

  assert.ok(timing.cold_launch_ms <= 8_000,
    `Owner qualification cold launch exceeded 8 s: ${timing.cold_launch_ms} ms`);
  assert.ok(timing.import_to_owner_fit_ms <= 8_000,
    `Owner IMS first useful view exceeded 8 s: ${timing.import_to_owner_fit_ms} ms`);

  const report = {
    schema: packagedApp
      ? "loci.image-first-owner-ims-packaged-qa/v1"
      : "loci.image-first-owner-ims-development-qa/v1",
    status: "passed",
    started_at: startedAt,
    elapsed_seconds: (performance.now() - journeyStarted) / 1000,
    invocation: packagedApp
      ? "LOCI_QA_OWNER_IMS=<authorized-absolute-file> LOCI_PACKAGED_APP=<absolute-Loci.app> node tests/image-first-owner-ims.qa.mjs"
      : "LOCI_QA_OWNER_IMS=<authorized-absolute-file> LOCI_QA_DEV=1 node tests/image-first-owner-ims.qa.mjs",
    source: sourceIdentity,
    build: buildIdentity,
    owner_ims: {
      filename: ownerName,
      sha256_before: ownerSha256Before,
      sha256_after: ownerSha256After,
      logical_tczyx: [1, 3, 1, 10121, 8998],
      dtype: "uint8",
      levels: 5,
      observed_channel_names: ownerSource.metadata.channel_names,
      observed_physical_calibration: ownerSource.metadata.physical_calibration ?? null,
      observed_geometry: ownerSource.metadata.geometry ?? null,
      calibration_assessment: "Recorded source metadata only; physical validity was not assessed.",
      biological_interpretation: null,
    },
    optional_owner_volume: volumeSource ? {
      filename: volumeName,
      sha256_before: volumeSha256Before,
      sha256_after: volumeSha256After,
      logical_tczyx: [1, 2, 96, 2048, 2048],
      dtype: "uint16",
      levels: 5,
      observed_channel_names: volumeSource.metadata.channel_names,
      observed_physical_calibration: volumeSource.metadata.physical_calibration ?? null,
      biological_interpretation: null,
      evidence: volumeEvidence,
    } : null,
    source_display: {
      defaults,
      initial_source_view: initialSourceView,
      reset_source_view_revision: resetSourceView.revision,
      rgb_override_source_view_revision: overriddenSourceView.revision,
      restored_source_view_revision: restoredSourceView.revision,
      fitted_camera_and_edges: fitted,
      native_camera: nativeCamera,
      native_edge_cameras: edgeCameras,
      image_information: informationObservation,
    },
    numerical_comparison: numericalComparison,
    assertions: {
      exact_level4_full_rgb_matches_direct_hdf5: true,
      exact_level0_central_rgb_matches_direct_hdf5: true,
      acquisition_defaults_observed_without_prepopulation: true,
      full_fit_level4_and_all_edges_visible: true,
      native_one_to_one_level0: true,
      native_top_left_and_bottom_right_accessible: true,
      channel_reset_restores_source_defaults: true,
      rgb_plane_override_and_restore: true,
      image_information_close_and_escape: true,
      source_bytes_immutable: true,
      renderer_captures_path_free_except_filename: true,
      external_requests: [...externalRequests],
      page_errors: pageErrors,
      console_errors: consoleErrors,
      no_biological_claims: true,
    },
    renderer_exposure: rendererExposure,
    timing_ms: timing,
    performance_budgets: {
      cold_launch_ms: 8_000,
      owner_first_useful_view_ms: 8_000,
      cached_owner_2d_pan: { p95_ms: 33.4, p99_ms: 50 },
      cached_owner_2d_wheel_zoom: { p95_ms: 33.4, p99_ms: 50 },
    },
    process_resources: {
      sampled_launch_tree_rss: processTreeRss,
      isolated_owner_first_view_phase: true,
    },
    captures_private: captures,
    development_renderer_response_sha256: development
      ? Object.fromEntries([...rendererResponseHashes].sort(([a], [b]) => a.localeCompare(b)))
      : null,
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
  const reportPath = path.join(runRoot, "qa-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(reportPath, 0o600);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await capture("failure").catch(() => undefined);
  await stopRssSampling().catch(() => undefined);
  const failurePath = path.join(runRoot, "qa-failure.json");
  await fs.writeFile(failurePath, `${JSON.stringify({
    schema: packagedApp
      ? "loci.image-first-owner-ims-packaged-qa-failure/v1"
      : "loci.image-first-owner-ims-development-qa-failure/v1",
    error: safeError(error),
    source: sourceIdentity,
    build: buildIdentity,
    owner_filename: ownerName,
    owner_sha256_before: ownerSha256Before,
    optional_volume_filename: volumeName,
    optional_volume_sha256_before: volumeSha256Before,
    timing_ms: timing,
    process_resources: { sampled_launch_tree_rss: processTreeRss },
    page_errors: pageErrors.map(safeError),
    console_errors: consoleErrors.map(safeError),
    captures_private: captures,
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(failurePath, 0o600);
  throw error;
} finally {
  await close();
}
