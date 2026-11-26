import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { closeSettings, openSettings } from "./settings-qa-helpers.mjs";
import { fileMenuAction, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const defaultBundle = path.join(desktopRoot, "out", "local-unsigned", "Loci-win32-x64");
const bundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? defaultBundle);
const source = process.env.LOCI_QA_IMAGE;
assert.equal(process.platform, "win32", "This smoke is for a native Windows package.");
assert.ok(source && path.isAbsolute(source), "LOCI_QA_IMAGE must be an authorized absolute RGB or scalar fixture path.");
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(os.tmpdir(), "loci-windows-smoke"));
const relativeOutput = path.relative(path.dirname(desktopRoot), outputRoot);
assert.ok(path.isAbsolute(relativeOutput) || relativeOutput.startsWith(`..${path.sep}`), "LOCI_QA_OUTPUT_ROOT must be outside the checkout.");

const executable = path.join(bundle, "Loci.exe");
const worker = path.join(bundle, "resources", "loci-engine", "loci-engine.exe");
const runRoot = path.join(outputRoot, new Date().toISOString().replaceAll(":", "-"));
const userData = path.join(runRoot, "user-data");
const studyPath = path.join(runRoot, "windows-image-first.loci-study");
await fs.mkdir(userData, { recursive: true });

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function exists(file) {
  await fs.access(file);
  return true;
}
await Promise.all([exists(executable), exists(worker), exists(source)]);
const fixtureHash = await sha256(source);
const cellHash = "4ca900e6f671854437bdf57ed298aacd2b4e55205edcfe2a242fd5b08447e221";
if (process.env.LOCI_QA_CELL_ORACLE === "1") assert.equal(fixtureHash, cellHash);
const isCell = fixtureHash === cellHash;
const identity = { executable_sha256: await sha256(executable), worker_sha256: await sha256(worker) };
const health = await new Promise((resolve, reject) => {
  const child = spawn(worker, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code !== 0) reject(new Error(`Frozen worker exited ${code}: ${stderr}`));
    else {
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    }
  });
  child.stdin.end('{"id":"windows-smoke-health","method":"health","params":{}}\n');
});
assert.equal(health.result?.status, "ready", "Packaged frozen worker health failed.");
const discovery = JSON.parse((await run(worker, ["--cli", "discover"], { windowsHide: true })).stdout);
assert.equal(discovery.schema, "loci.operations/v1", "Packaged frozen worker discovery contract failed.");

let app;
async function launch(profile) {
  app = await electron.launch({
    executablePath: executable,
    args: ["--user-data-dir=" + profile],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images") return { canceled: false, filePaths: [values.source] };
      if (options?.title === "Open research study") return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => args.at(-1)?.title === "Save research study as"
      ? { canceled: false, filePath: values.study } : { canceled: true, filePath: undefined };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source, study: studyPath });

  await page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 30_000 });
  return page;
}

async function checkCell(page, snapshot) {
  const { dimensions, levels } = snapshot.sources[0].metadata;
  const calibration = levels[0].calibration;
  assert.equal(calibration.axes, "YX");
  assert.equal(calibration.unit, "µm");
  assert.equal(calibration.spacing.length, 2);
  for (const spacing of calibration.spacing) assert.ok(Math.abs(spacing - 0.107) < 1e-12);
  assert.deepEqual(dimensions, { x: 550, y: 660, c: 1, s: 1, t: 1, z: 1 });
  // Independent four-neighbor labeling of the pinned PNG at raw > 128, area >= 2 µm².
  const rows = (await page.evaluate(id => window.lociResearch.execute("result", { result_id: id }),
    snapshot.results[0].id)).measurements;
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.voxel_count, 11536);
  assert.equal(row.measure_unit, "um^2");
  assert.ok(Math.abs(row.measure - 11536 * 0.107 ** 2) < 1e-8);
  const channels = Object.values(row.intensity);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].sum, 2086627);
  return { dimensions, calibration, pixels: row.voxel_count, area_um2: row.measure, raw_sum: channels[0].sum };
}

try {
  let page = await launch(userData);
  const graphics = await app.evaluate(async ({ app }) => {
    const info = await app.getGPUInfo("basic").catch(() => null);
    return { devices: info?.gpuDevice ?? null, features: app.getGPUFeatureStatus(),
      hardware_acceleration_enabled: app.isHardwareAccelerationEnabled() };
  });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 60_000 });
  const imported = await waitForSnapshot(page, s => s?.sources?.length === 1, "imported source");
  assert.equal(imported.sources[0].sha256, fixtureHash);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector(".image-viewport")?.getAttribute("data-cache-bytes")) > 0);
  await selectWorkbenchTool(page, "Analyze");
  if (isCell) {
    await page.getByRole("button", { name: "Whole image", exact: true }).click();
    await page.getByLabel("Segmentation model", { exact: true }).selectOption("classical");
    await page.getByLabel("Segmentation method", { exact: true }).selectOption("components");
    await page.getByLabel("Threshold", { exact: true }).fill("128");
    await page.getByLabel("Object foreground", { exact: true }).selectOption("bright");
    await page.getByLabel("Minimum object measure", { exact: true }).fill("2");
    await page.getByRole("checkbox", { name: "Exclude border objects" }).uncheck();
  }
  await page.getByRole("button", { name: "Run recipe" }).click();
  const analyzed = await waitForSnapshot(page, s => s?.results?.length === 1, "analysis", 120_000);
  const measurements = isCell ? await checkCell(page, analyzed) : null;
  await fileMenuAction(page, "Save as study…");
  await page.locator(".session-save-state").filter({ hasText: /^Saved locally$/ }).waitFor();
  await fs.access(path.join(studyPath, "study.sqlite3"));
  await page.keyboard.press("F1");
  await page.getByRole("dialog", { name: "User manual" }).waitFor({ state: "visible" });
  await page.getByLabel("Close user manual").click();
  const settings = await openSettings(app, page, { trigger: page.getByLabel("Open settings").first() });
  await closeSettings(settings, "Close settings");
  await app.close();
  app = undefined;
  page = await launch(path.join(runRoot, "reopen-profile"));
  await fileMenuAction(page, "Open study");
  const reopened = await waitForSnapshot(page, s => s?.results?.length === 1, "cold reopen");
  assert.equal(reopened.sources[0].sha256, fixtureHash);
  assert.equal(reopened.results[0].id, analyzed.results[0].id);
  assert.equal(reopened.results[0].revision_hash, analyzed.results[0].revision_hash);
  if (isCell) assert.deepEqual(await checkCell(page, reopened), measurements);
  const report = { status: "passed", bundle, identity, source_sha256: fixtureHash, graphics,
    fixture: isCell ? { original: "scikit-image data/cell.png", license: "CC0-1.0",
      original_sha256: "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515" } : undefined,
    inference_device: null, recipe: isCell ? "classical connected components" : "default",
    measurements, reopened_result: reopened.results[0].id, worker_schema: discovery.schema };
  await fs.writeFile(path.join(runRoot, "journey.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  if (app) await app.close();
}
