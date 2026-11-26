import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { closeSettings, openSettings } from "./settings-qa-helpers.mjs";
import { fileMenuAction, selectResultSection, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

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
async function workerStatus(method) {
  const request = run(worker, [], { windowsHide: true, timeout: 30_000, env: {
    ...process.env, LOCI_MODEL_HOME: path.join(runRoot, "models"), CELLPOSE_LOCAL_MODELS_PATH: path.join(runRoot, "models"),
  } });
  // Launch errors are delivered by execFile; an early exit can also close stdin.
  request.child.stdin.on("error", () => {});
  request.child.stdin.end(JSON.stringify({ id: method, method, params: {} }) + "\n");
  const response = JSON.parse((await request).stdout);
  assert.equal(response.id, method);
  assert.ok(response.result);
  return response.result;
}
const health = await workerStatus("health");
assert.equal(health.status, "ready", "Packaged frozen worker health failed.");
const discovery = JSON.parse((await run(worker, ["--cli", "discover"], { windowsHide: true })).stdout);
assert.equal(discovery.schema, "loci.operations/v1", "Packaged frozen worker discovery contract failed.");

async function queryWindowsHardware() {
  const system32 = path.join(process.env.SystemRoot, "System32");
  const powershell = path.join(system32, "WindowsPowerShell/v1.0/powershell.exe");
  const options = { windowsHide: true, timeout: 8000 };
  let controllers = null, nvidia = null;
  try {
    const query = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion)";
    controllers = JSON.parse((await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", query], options)).stdout.trim());
  } catch { /* CIM can be unavailable in a restricted desktop session. */ }
  for (const smi of [path.join(system32, "nvidia-smi.exe"),
    path.join(process.env.ProgramFiles, "NVIDIA Corporation/NVSMI/nvidia-smi.exe")]) {
    try {
      const args = ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"];
      const { stdout } = await run(smi, args, options);
      nvidia = stdout.trim().split(/\r?\n/).map(line => {
        const [, name, driver, mib] = line.match(/^(.+),\s*([^,]+),\s*(\d+)$/);
        return { name, driver, dedicated_memory_mib: Number(mib) };
      });
      break;
    } catch { /* Optional vendor diagnostic. Never install a driver or tool. */ }
  }
  return { os_release: os.release(), arch: os.arch(), cpu_models: [...new Set(os.cpus().map(cpu => cpu.model))],
    total_ram_bytes: os.totalmem(), windows_video_controllers: controllers, nvidia_smi: nvidia };
}

const hardware = await queryWindowsHardware().catch(() => null);
const cellposeStatus = await workerStatus("cellpose_status").then(status => ({
  package_version: status.package.installed_version,
  devices: { cpu: status.devices.cpu, cuda: status.devices.cuda, mps: status.devices.mps },
})).catch(() => null);

const exported = path.join(runRoot, "reviewed-export");
let app, page, graphics;
let stage = "launch";
async function launch(profile) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    env,
    executablePath: executable,
    args: ["--user-data-dir=" + profile],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images") return { canceled: false, filePaths: [values.source] };
      if (options?.title === "Open research study") return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const target = { "Save research study as": values.study, "Export reviewed result bundle": values.exported }[args.at(-1)?.title];
      return { canceled: !target, filePath: target };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source, study: studyPath, exported });

  await page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 30_000 });
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
  await launch(userData);
  graphics = await app.evaluate(async ({ app }) => {
    const info = await app.getGPUInfo("basic").catch(() => null);
    return { devices: info?.gpuDevice?.map(({ active, vendorId, deviceId, vendorString, deviceString }) =>
      ({ active, vendorId, deviceId, vendorString, deviceString })) ?? null, features: app.getGPUFeatureStatus(),
      hardware_acceleration_enabled: app.isHardwareAccelerationEnabled() };
  }).catch(() => null);
  stage = "import and render";
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 60_000 });
  const imported = await waitForSnapshot(page, s => s?.sources?.length === 1, "imported source");
  assert.equal(imported.sources[0].sha256, fixtureHash);
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector(".image-viewport")?.getAttribute("data-cache-bytes")) > 0);
  // Interior points on the pinned cell and its background, in native source pixels.
  // Read the painted canvas through the viewer camera to catch a blank tile.
  let displayedCell;
  if (isCell) {
    const samples = await page.waitForFunction(() => {
      const viewport = document.querySelector(".image-viewport");
      const canvas = viewport?.querySelector("canvas");
      const camera = JSON.parse(viewport?.getAttribute("data-camera") ?? "null");
      const context = canvas?.getContext("2d");
      if (!camera || !context || !canvas.clientWidth || !canvas.clientHeight) return false;
      const pixels = [[425, 375], [110, 300]].map(([x, y]) => {
        const px = Math.floor(canvas.width / 2 + (x - camera.x) * camera.scale * canvas.width / canvas.clientWidth);
        const py = Math.floor(canvas.height / 2 + (y - camera.y) * camera.scale * canvas.height / canvas.clientHeight);
        return Array.from(context.getImageData(px, py, 1, 1).data);
      });
      return pixels.every(rgba => rgba[3] === 255) && pixels[0][0] > pixels[1][0] + 30 && pixels;
    });
    displayedCell = await samples.jsonValue();
    await samples.dispose();
  }
  stage = "analysis";
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
  let exportCheck;
  if (isCell) {
    stage = "review and export";
    await page.locator(`button[data-result-id="${analyzed.results[0].id}"]`).click();
    await selectWorkbenchTool(page, "Info");
    await selectResultSection(page, "Export");
    const exportButton = page.getByRole("button", { name: "Export result", exact: true });
    assert.equal(await exportButton.isEnabled(), false);
    await selectResultSection(page, "Review");
    await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await waitForSnapshot(page, s => s?.results?.[0]?.review?.disposition === "reviewed", "review");
    await selectResultSection(page, "Export");
    await exportButton.click();
    const manifestPath = path.join(exported, "manifest.json");
    const deadline = Date.now() + 60_000;
    while (!(await fs.stat(manifestPath).catch(() => null))?.isFile()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for reviewed export");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    for (const member of manifest.files) {
      assert.equal(path.basename(member.name), member.name);
      assert.equal(await sha256(path.join(exported, member.name)), member.sha256);
    }
    const record = JSON.parse(await fs.readFile(path.join(exported, "result.json"), "utf8"));
    assert.equal(record.result.revision_hash, analyzed.results[0].revision_hash);
    assert.equal(record.review.disposition, "reviewed");
    assert.equal(record.source.sha256, fixtureHash);
    const python = path.resolve(desktopRoot, "../engine/.venv/Scripts/python.exe");
    exportCheck = JSON.parse((await run(python, [path.join(import.meta.dirname, "windows-cell-fixture.py"),
      "--verify-export", exported])).stdout);
  }
  stage = "save study";
  await fileMenuAction(page, "Save as study…");
  await page.locator(".session-save-state").filter({ hasText: /^Saved locally$/ }).waitFor();
  await fs.access(path.join(studyPath, "study.sqlite3"));
  stage = "manual and settings";
  await page.keyboard.press("F1");
  await page.getByRole("dialog", { name: "User manual" }).waitFor({ state: "visible" });
  await page.getByLabel("Close user manual").click();
  const settings = await openSettings(app, page, { trigger: page.getByLabel("Open settings").first() });
  await closeSettings(settings, "Close settings");
  await app.close();
  app = undefined;
  stage = "cold reopen";
  await launch(path.join(runRoot, "reopen-profile"));
  await fileMenuAction(page, "Open study");
  const reopened = await waitForSnapshot(page, s => s?.results?.length === 1, "cold reopen");
  assert.equal(reopened.sources[0].sha256, fixtureHash);
  assert.equal(reopened.results[0].id, analyzed.results[0].id);
  assert.equal(reopened.results[0].revision_hash, analyzed.results[0].revision_hash);
  if (isCell) {
    assert.equal(reopened.results[0].review?.disposition, "reviewed");
    assert.deepEqual(await checkCell(page, reopened), measurements);
  }
  const report = { status: "passed", bundle, identity, source_sha256: fixtureHash, graphics, hardware, cellpose_status: cellposeStatus,
    fixture: isCell ? { original: "scikit-image data/cell.png", license: "CC0-1.0",
      original_sha256: "8d23a7fb81f7cc877cd09f330357fc7f595651306e84e17252f6e0a1b3f61515" } : undefined,
    inference_device: null, recipe: isCell ? "classical connected components" : "default",
    measurements, displayed_cell_background_rgba: displayedCell, export_check: exportCheck, reopened_result: reopened.results[0].id, worker_schema: discovery.schema };
  await fs.writeFile(path.join(runRoot, "journey.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  // Only the pinned public fixture is eligible for captured window contents.
  if (isCell && page && !page.isClosed()) {
    await page.screenshot({ path: path.join(runRoot, "failure.png"), timeout: 5000 }).catch(() => {});
  }
  await fs.writeFile(path.join(runRoot, "journey.json"), JSON.stringify({
    status: "failed", stage, error: String(error), identity, source_sha256: fixtureHash, graphics, hardware, cellpose_status: cellposeStatus,
  }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
}
