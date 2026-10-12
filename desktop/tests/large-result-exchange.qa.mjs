/** Packaged, synthetic-only M6 remote exchange journey. Run after source and package qualification. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const ALLOWANCE = 256 * 1024 ** 2;
const SIDE = 16_384;
const EXPECTED_COUNT = 1_026;
const EXPECTED_L_AREA = 6 * SIDE - 9;
const CORNER_LABEL = 34;
const startedAt = new Date().toISOString();
const started = performance.now();
const checkpoints = [];
const rendererMessages = { initial: [], reopen: [] };
const inputRoundTrips = [];
const MEMORY_SAMPLE_MS = 500;
const memoryRuns = [];
const electronMemory = [];
let stage = "preflight";
let app;
let page;
let memorySampler;

function requiredPath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`Set ${name} to an explicit absolute path.`);
  return path.resolve(value);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep));
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileIdentity(file) {
  const stat = await fs.lstat(file);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `Expected a plain file: ${file}`);
  return { sha256: await sha256(file), bytes: stat.size };
}

async function executableIdentity(file) {
  const stat = await fs.stat(file);
  assert.equal(stat.isFile(), true, `Expected a packaged executable: ${file}`);
  await fs.access(file, constants.X_OK);
  return { sha256: await sha256(file), bytes: stat.size };
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function processTree(rootPid) {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,comm="], { timeout: 5_000, maxBuffer: 16 * 1024 ** 2 });
  const byPid = new Map();
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, rssText, command] = match;
    const entry = { pid: Number(pidText), ppid: Number(ppidText), name: path.basename(command), rss_bytes: Number(rssText) * 1024 };
    byPid.set(entry.pid, entry);
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry.pid);
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set();
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index];
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    found.push(entry);
    queue.push(...(children.get(pid) ?? []));
  }
  return found.sort((left, right) => left.pid - right.pid);
}

async function startMemorySampler(instance, label) {
  const rootPid = instance.process()?.pid ?? null;
  const rawFile = `process-memory-${label}.jsonl`;
  const summary = {
    label, root_pid: rootPid, raw_samples: rawFile, requested_interval_ms: MEMORY_SAMPLE_MS,
    baseline_scope: label === "initial" ? "first empty launch sample before source import" : "first empty cold-reopen sample before study open",
    note: "Each process starts at its first observed RSS; workers appearing later have no pre-source baseline. RSS peaks are sampled, not true high-water marks.",
    sample_count: 0, failed_samples: 0, missed_intervals: 0, min_interval_ms: null, mean_interval_ms: null, max_interval_ms: null,
    tree_first_observed_rss_bytes: null, tree_sampled_peak_rss_bytes: null,
    phase_samples: {}, processes: [], errors: [],
    disk_samples: [], sampled_peak_run_directory_bytes: 0,
  };
  const observations = new Map();
  let previousPids = new Set();
  let previousTime = null;
  let intervalTotal = 0;
  let intervalCount = 0;
  let pending = null;
  let timer;
  let handle;
  try { handle = await fs.open(path.join(runRoot, rawFile), "wx"); }
  catch (error) {
    summary.errors.push({ kind: "evidence_open", name: error?.name ?? "Error", code: error?.code ?? null });
    memoryRuns.push(summary);
    return;
  }
  async function sample() {
    const elapsedMs = performance.now() - started;
    const intervalMs = previousTime === null ? null : elapsedMs - previousTime;
    previousTime = elapsedMs;
    if (intervalMs !== null) {
      intervalTotal += intervalMs;
      intervalCount++;
      summary.min_interval_ms = Math.min(summary.min_interval_ms ?? intervalMs, intervalMs);
      summary.max_interval_ms = Math.max(summary.max_interval_ms ?? intervalMs, intervalMs);
      summary.missed_intervals += Math.max(0, Math.round(intervalMs / MEMORY_SAMPLE_MS) - 1);
    }
    try {
      if (rootPid === null) throw Object.assign(new Error("App PID unavailable"), { code: "NO_APP_PID" });
      const processes = await processTree(rootPid);
      if (!processes.some((entry) => entry.pid === rootPid)) throw Object.assign(new Error("App process missing from ps"), { code: "APP_NOT_IN_PS" });
      const currentPids = new Set(processes.map((entry) => entry.pid));
      const total = processes.reduce((sum, entry) => sum + entry.rss_bytes, 0);
      for (const entry of processes) {
        let observation = observations.get(entry.pid);
        if (!observation || !previousPids.has(entry.pid)) {
          observation = {
            pid: entry.pid, ppid: entry.ppid, name: entry.name,
            first_observed_phase: stage, first_observed_elapsed_seconds: elapsedMs / 1000,
            first_observed_rss_bytes: entry.rss_bytes, sampled_peak_rss_bytes: entry.rss_bytes,
            samples: 0,
          };
          observations.set(entry.pid, observation);
        }
        observation.samples++;
        observation.last_observed_rss_bytes = entry.rss_bytes;
        observation.sampled_peak_rss_bytes = Math.max(observation.sampled_peak_rss_bytes, entry.rss_bytes);
      }
      previousPids = currentPids;
      summary.sample_count++;
      if (summary.tree_first_observed_rss_bytes === null) summary.tree_first_observed_rss_bytes = total;
      summary.tree_sampled_peak_rss_bytes = Math.max(summary.tree_sampled_peak_rss_bytes ?? total, total);
      summary.phase_samples[stage] = (summary.phase_samples[stage] ?? 0) + 1;
      await handle.writeFile(JSON.stringify({ elapsed_ms: elapsedMs, stage, total_rss_bytes: total, processes }) + "\n");
    } catch (error) {
      summary.failed_samples++;
      summary.errors.push({ kind: "evidence_sample", name: error?.name ?? "Error", message: error?.message ?? String(error) });
    }
  }
  pending = sample();
  await pending;
  pending = null;
  timer = setInterval(() => {
    if (pending) { summary.missed_intervals++; return; }
    pending = sample().finally(() => { pending = null; });
  }, MEMORY_SAMPLE_MS);
  memorySampler = {
    async stop() {
      clearInterval(timer);
      if (pending) await pending;
      await handle.close().catch((error) => summary.errors.push({ kind: "evidence_close", name: error?.name ?? "Error", code: error?.code ?? null }));
      summary.mean_interval_ms = intervalCount ? intervalTotal / intervalCount : null;
      summary.processes.push(...observations.values());
      for (const item of summary.processes) item.observed_growth_bytes = item.sampled_peak_rss_bytes - item.first_observed_rss_bytes;
      summary.tree_observed_growth_bytes = summary.tree_sampled_peak_rss_bytes === null ? null : summary.tree_sampled_peak_rss_bytes - summary.tree_first_observed_rss_bytes;
      memoryRuns.push(summary);
    },
  };
}

async function stopMemorySampler() {
  const current = memorySampler;
  memorySampler = undefined;
  if (current) await current.stop();
}

async function electronMemorySnapshot(checkpoint) {
  if (!app) return;
  try {
    const processes = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({
      pid: metric.pid, type: metric.type,
      working_set_bytes: Number.isFinite(metric.memory?.workingSetSize) ? metric.memory.workingSetSize * 1024 : null,
      peak_working_set_bytes: Number.isFinite(metric.memory?.peakWorkingSetSize) ? metric.memory.peakWorkingSetSize * 1024 : null,
    })));
    electronMemory.push({ checkpoint, elapsed_seconds: (performance.now() - started) / 1000, processes });
  } catch (error) {
    electronMemory.push({ checkpoint, elapsed_seconds: (performance.now() - started) / 1000, error: { name: error?.name ?? "Error", code: error?.code ?? null } });
  }
}

const appBundle = requiredPath("LOCI_PACKAGED_APP");
const outputRoot = requiredPath("LOCI_QA_OUTPUT_ROOT");
const fixturePath = requiredPath("LOCI_QA_LARGE_FIXTURE");
const remoteBundlePath = requiredPath("LOCI_QA_REMOTE_BUNDLE");

assert.equal(process.platform, "darwin", "This packaged journey is qualified for macOS only.");
assert.equal(inside(outputRoot, fixturePath), false, "The source fixture must be outside QA output.");
assert.equal(inside(outputRoot, remoteBundlePath), false, "The remote bundle must be outside QA output.");
assert.equal(inside(appBundle, outputRoot), false, "QA output must not alter the packaged app.");
assert.equal(path.basename(fixturePath), "source.ome.tif", "Use the named synthetic qualification fixture.");

const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const workerPath = path.join(appBundle, "Contents", "Resources", "loci-engine", "loci-engine");
const archivePath = path.join(appBundle, "Contents", "Resources", "app.asar");
const runName = `large-exchange-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
const runRoot = path.join(outputRoot, runName);
const screenshots = path.join(runRoot, "screenshots");
const userData = path.join(runRoot, "user-data");
const reopenUserData = path.join(runRoot, "reopen-user-data");
const studyPath = path.join(runRoot, "saved-exchange.loci-study");
const exportPath = path.join(runRoot, "re-exported-large-result");
const verifierPath = path.join(projectRoot, "scripts", "verify-large-exchange.py");
const verifierPython = path.join(projectRoot, "engine", ".venv", "bin", "python");

await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(runRoot);
await Promise.all([fs.mkdir(screenshots), fs.mkdir(userData), fs.mkdir(reopenUserData)]);

let packageBefore;
let fixtureBefore;
let bundleBefore;
let remoteProducer;
let sourceIdentity;
let runtime;
let adoptedResult;
let correctedResult;
let originalSource;
let exportIdentity;
let cancellation;
let verification = {};
const responsiveness = { input_p95_ms: null, max_input_round_trip_ms: null };
const dialogCalls = [];

async function noUiError(action) {
  const alerts = await page.locator(".research-alert[role=alert]").allTextContents();
  assert.deepEqual(alerts, [], `${action}: ${alerts.join(" | ")}`);
  const exceptions = rendererMessages.initial.concat(rendererMessages.reopen).filter((item) => item.type === "pageerror");
  assert.deepEqual(exceptions, [], `${action}: renderer exception`);
}

async function checkpoint(name) {
  await noUiError(name);
  const destination = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: destination, fullPage: true });
  await electronMemorySnapshot(name);
  checkpoints.push({ name, seconds: (performance.now() - started) / 1000 });
  return destination;
}

async function launch(userDataPath, messages, bounds = { width: 1280, height: 900 }) {
  const instance = await electron.launch({ executablePath, args: [`--user-data-dir=${userDataPath}`], cwd: desktopRoot, timeout: 120_000 });
  const window = await instance.firstWindow();
  window.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
  window.on("console", (message) => {
    if (message.type() === "error") messages.push({ type: "console-error", text: message.text() });
  });
  await instance.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds(size), bounds);
  await window.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible", timeout: 120_000 });
  return { instance, window };
}

async function installDialogs(instance, reopening = false) {
  await instance.evaluate(({ dialog }, values) => {
    globalThis.__lociLargeQaDialogs = [];
    const record = (kind, title) => globalThis.__lociLargeQaDialogs.push({ kind, title });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      record("open", title);
      if (title === "Add microscopy or medical images" && !values.reopening)
        return { canceled: false, filePaths: [values.fixture] };
      if (title === "Choose exported large result bundle directory" && !values.reopening)
        return { canceled: false, filePaths: [values.bundle] };
      if (title === "Open research study" && values.reopening)
        return { canceled: false, filePaths: [values.study] };
      throw new Error(`Unexpected open picker: ${String(title)}`);
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      record("save", title);
      if (title === "Export reviewed result bundle" && !values.reopening)
        return { canceled: false, filePath: values.export };
      if (title === "Save research study as" && !values.reopening)
        return { canceled: false, filePath: values.study };
      throw new Error(`Unexpected save picker: ${String(title)}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { fixture: fixturePath, bundle: remoteBundlePath, study: studyPath, export: exportPath, reopening });
}

async function collectDialogs(instance) {
  const calls = await instance.evaluate(() => globalThis.__lociLargeQaDialogs ?? []).catch(() => []);
  dialogCalls.push(...calls);
}

async function close(instance) {
  await electronMemorySnapshot("before-close");
  await stopMemorySampler();
  await collectDialogs(instance);
  const closed = instance.waitForEvent("close", { timeout: 45_000 });
  await instance.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
}

async function snapshot() { return page.evaluate(() => window.lociResearch.getSnapshot()); }
async function resultPage(id, offset = 0, limit = 200) {
  return page.evaluate(({ result_id, offset, limit }) => window.lociResearch.execute("result", { result_id, offset, limit }), { result_id: id, offset, limit });
}
async function verifyNumerics(kind, root, resultId = null, removed = false, fixture = null) {
  const args = [verifierPath, kind === "export" ? "--export" : "--study", root];
  if (resultId) args.push("--result-id", resultId);
  if (removed) args.push("--removed");
  if (fixture) args.push("--fixture", fixture);
  const { stdout } = await run(verifierPython, args, { cwd: projectRoot, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.objects, EXPECTED_COUNT - Number(removed));
  return receipt;
}
function assertRow(row, label, count, value) {
  assert.equal(row.label, label);
  assert.equal(row.voxel_count, count);
  assert.equal(row.measure, count * .375);
  assert.equal(row.measure_unit, "um^2");
  assert.equal(Object.keys(row.intensity).length, 1);
  const stats = Object.values(row.intensity)[0];
  assert.deepEqual(stats, { max: value, mean: value, min: value, std_population: 0, sum: count * value });
}
async function dismissCancellationAlert() {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    assert.match((await alert.innerText()).toLowerCase(), /cancel/);
    await alert.getByRole("button", { name: "Dismiss" }).click();
  }
}

async function waitFor(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    await noUiError(label);
    last = await check();
    if (last) return last;
    await page.waitForTimeout(400);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function selectedViewportReady() {
  const viewport = page.getByRole("region", { name: "Large quantitative result" });
  await viewport.waitFor({ state: "visible", timeout: 120_000 });
  await waitFor(() => viewport.getAttribute("data-ready").then((value) => value === "true"), "exact viewport", 120_000);
  return viewport;
}

try {
  stage = "input identities";
  packageBefore = {
    executable: await executableIdentity(executablePath),
    worker: await executableIdentity(workerPath),
    asar: await fileIdentity(archivePath),
  };
  fixtureBefore = await fileIdentity(fixturePath);
  const manifestPath = path.join(remoteBundlePath, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  bundleBefore = {
    manifest: await fileIdentity(manifestPath),
    result: await fileIdentity(path.join(remoteBundlePath, "result.json")),
    objects_sqlite3: await fileIdentity(path.join(remoteBundlePath, "objects.sqlite3")),
    objects_csv: await fileIdentity(path.join(remoteBundlePath, "objects.csv")),
    image_ome_tif: await fileIdentity(path.join(remoteBundlePath, "image.ome.tif")),
    labels_ome_tif: await fileIdentity(path.join(remoteBundlePath, "labels.ome.tif")),
    file_count: manifest.files.length,
  };
  verification.remote_input = await verifyNumerics("export", remoteBundlePath, null, false, fixturePath);
  const remoteRecord = JSON.parse(await fs.readFile(path.join(remoteBundlePath, "result.json"), "utf8"));
  assert.equal(remoteRecord.source.sha256, fixtureBefore.sha256);
  assert.equal(remoteRecord.result.source_sha256, fixtureBefore.sha256);
  remoteProducer = {
    evidence_kind: "bundle-recorded producer claims; scheduler or host execution requires a separate receipt",
    result_id: remoteRecord.result.id,
    revision_hash: remoteRecord.result.revision_hash,
    source_sha256: remoteRecord.result.source_sha256,
    engine_version: remoteRecord.result.engine_version,
    runtime: remoteRecord.result.provenance.runtime,
  };

  const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = {
    head: await git("rev-parse", "HEAD"),
    tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"),
    harness_sha256: await sha256(new URL(import.meta.url)),
    oracle_sha256: await sha256(verifierPath),
  };
  assert.equal(await fs.access(studyPath).then(() => true, () => false), false);
  assert.equal(await fs.access(exportPath).then(() => true, () => false), false);

  stage = "launch and import source";
  ({ instance: app, window: page } = await launch(userData, rendererMessages.initial));
  await startMemorySampler(app, "initial");
  await electronMemorySnapshot("initial-empty-before-import");
  await installDialogs(app);
  assert.equal(await page.locator("main.image-first-empty").isVisible(), true, "Expected an empty new session");
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 180_000 });
  await page.locator(".research-sources").getByRole("button", { name: /^source\.ome\.tif/ }).waitFor({ state: "visible", timeout: 180_000 });
  const imported = await snapshot();
  assert.equal(imported.sources.length, 1);
  originalSource = imported.sources[0];
  assert.equal(originalSource.sha256, fixtureBefore.sha256);
  assert.equal(originalSource.source_kind, "native");
  assert.deepEqual([originalSource.metadata.dimensions.y, originalSource.metadata.dimensions.x], [SIDE, SIDE]);
  assert.equal(originalSource.metadata.channel_dtypes[0], "uint16");
  assert.deepEqual(originalSource.metadata.physical_calibration, { axes: "YX", spacing: [.75, .5], unit: "µm" });
  await checkpoint("imported-source-for-exchange");

  stage = "import remote result";
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("large-components");
  const importButton = page.getByRole("button", { name: "Import remote result…" });
  await importButton.waitFor({ state: "visible" });
  await waitFor(() => importButton.isEnabled(), "import button enabled", 60_000);
  await importButton.click();

  stage = "cancel durable adoption";
  const firstJob = await waitFor(async () => {
    const state = await snapshot();
    return state.jobs.find((j) => j.operation === "large_result_adopt" && j.state === "running");
  }, "running durable adoption", 120_000);
  assert.equal((await snapshot()).results.length, 0, "Adoption published before cancellation");
  await page.getByRole("button", { name: /Jobs/ }).click();
  const jobRow = page.getByRole("region", { name: "Job center" }).locator(".workbench-jobs__row").filter({ hasText: firstJob.id.slice(0, 8) });
  await jobRow.getByRole("button", { name: "Cancel" }).waitFor({ state: "visible", timeout: 15_000 });
  const cancelRequested = performance.now();
  await jobRow.getByRole("button", { name: "Cancel" }).click();
  let cancelled;
  while (performance.now() - cancelRequested < 5_000) {
    const state = await snapshot();
    cancelled = state.jobs.find((job) => job.id === firstJob.id);
    if (cancelled?.state === "cancelled") {
      assert.equal(state.results.length, 0, "Cancelled adoption published a result");
      break;
    }
    await page.waitForTimeout(100);
  }
  const cancelElapsed = performance.now() - cancelRequested;
  assert.equal(cancelled?.state, "cancelled", `Adoption cancellation exceeded five seconds; last ${cancelled?.state}`);
  assert.ok(cancelElapsed <= 5_000);
  cancellation = { job_id: firstJob.id, request_key: firstJob.request_key, latency_ms: cancelElapsed, final_state: cancelled.state, published_results: 0 };
  await dismissCancellationAlert();
  await checkpoint("cancelled-adoption-no-result");
  assert.equal((await snapshot()).results.length, 0);
  await page.getByRole("button", { name: /Jobs/ }).click();

  stage = "explicit adoption retry";
  await waitFor(() => importButton.isEnabled(), "adoption retry enabled", 30_000);
  await importButton.click();
  const retryJob = await waitFor(async () => {
    const state = await snapshot();
    return state.jobs.find((j) => j.operation === "large_result_adopt" && j.id !== firstJob.id && ["queued", "running", "succeeded", "failed"].includes(j.state));
  }, "fresh adoption retry", 120_000);
  assert.notEqual(retryJob.request_key, firstJob.request_key, "Retry reused cancelled submission");
  cancellation.retry_job_id = retryJob.id;
  const adoptJob = await waitFor(async () => {
    const state = await snapshot();
    return state.jobs.find((j) => j.id === retryJob.id && ["succeeded", "failed"].includes(j.state));
  }, "adoption job resolution", 900_000);
  assert.equal(adoptJob.state, "succeeded", `Adoption job failed: ${adoptJob.error}`);
  assert.equal((await snapshot()).jobs.find((job) => job.id === firstJob.id)?.state, "cancelled");

  // Verify adopted result in study snapshot
  const postAdoptSnapshot = await snapshot();
  adoptedResult = postAdoptSnapshot.results.find((r) => r.kind === "large-components");
  assert.ok(adoptedResult, "Adopted result missing from study snapshot");
  assert.equal(adoptedResult.schema, "loci.research-result/v2");
  assert.equal(adoptedResult.source_id, originalSource.id);
  assert.equal(adoptedResult.source_sha256, fixtureBefore.sha256);
  assert.equal(adoptedResult.parent_id, null, "Adopted result must be a root result");
  assert.equal(postAdoptSnapshot.results.length, 1, "Retry published duplicate adopted roots");
  assert.equal(adoptedResult.object_count, EXPECTED_COUNT);
  assert.equal(adoptedResult.working_bytes, ALLOWANCE);
  assert.deepEqual(adoptedResult.arrays.image.shape, [SIDE, SIDE]);
  assert.deepEqual(adoptedResult.arrays.labels.shape, [SIDE, SIDE]);
  assert.equal(adoptedResult.arrays.image.dtype, "uint16");
  assert.equal(adoptedResult.arrays.labels.dtype, "uint32");
  assert.equal(adoptedResult.arrays.labels.tile_size, 512);
  assert.equal(adoptedResult.arrays.image.tile_size, 512);
  const adoptedPage = await resultPage(adoptedResult.id);
  assert.equal(adoptedPage.total_rows, adoptedResult.object_count);
  assert.ok(adoptedPage.provenance?.remote_exchange, "remote_exchange provenance must be recorded");
  assert.equal(adoptedPage.provenance.remote_exchange.manifest_sha256, bundleBefore.manifest.sha256);
  assert.equal(adoptedPage.provenance.remote_exchange.remote_result_id, verification.remote_input.result_id);
  assert.equal(adoptedPage.provenance.remote_exchange.remote_revision_hash, verification.remote_input.revision_hash);
  assert.deepEqual(adoptedPage.provenance.remote_exchange.remote_runtime, remoteProducer.runtime);
  assert.ok(adoptedPage.measurements.length > 0, "Measurements missing from adopted result");
  const firstMeasurement = adoptedPage.measurements[0];
  assert.deepEqual(adoptedPage.provenance.selection, { x: 0, y: 0, width: SIDE, height: SIDE, t: 0, c: 0, z: 0, level: 0 });
  assert.deepEqual(adoptedPage.provenance.geometry, { axes: "YX", frame: "image", unit: "um", affine: [[.5, 0, 0, 0], [0, .75, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] });
  assert.equal(adoptedPage.provenance.measurement_basis, "raw-selected-channel-values-on-result-grid");
  assert.equal(adoptedPage.provenance.execution_policy.core_size, 512);
  assert.equal(adoptedPage.provenance.execution_policy.connectivity, 4);
  assert.equal(adoptedPage.provenance.segmentation.threshold, 100);
  assertRow(firstMeasurement, 1, EXPECTED_L_AREA, 600);
  assertRow(adoptedPage.measurements[1], 2, 128 ** 2, 200);
  assertRow(adoptedPage.measurements[CORNER_LABEL - 1], CORNER_LABEL, 24 ** 2, 900);

  await selectedViewportReady();
  await checkpoint("adopted-large-result-view");

  stage = "exact inspection and whole-object correction";
  const selectedInspector = page.getByRole("region", { name: "Large result objects" });
  await page.getByRole("button", { name: "#1", exact: true }).click();
  await page.getByRole("button", { name: "Inspect object pixels" }).click();
  const viewport = await selectedViewportReady();
  await waitFor(async () => (await viewport.locator(".large-result-caption").innerText()).includes("X 0–511, Y 0–511"), "concave member region");
  assert.match(await viewport.getByRole("status").innerText(), /Native pixels/);
  await checkpoint("adopted-object-native-member");
  await page.getByRole("button", { name: "Remove object in new revision" }).click();
  correctedResult = await waitFor(async () => {
    const state = await snapshot();
    return state.results.find((item) => item.parent_id === adoptedResult.id && item.kind === "large-corrected-labels");
  }, "corrected adopted revision", 600_000);
  assert.equal(correctedResult.object_count, EXPECTED_COUNT - 1);
  assert.equal(correctedResult.source_id, originalSource.id);
  assert.equal(correctedResult.source_sha256, fixtureBefore.sha256);
  assert.notEqual(correctedResult.revision_hash, adoptedResult.revision_hash);
  assert.equal((await snapshot()).results.length, 2, "Correction lost history or made duplicates");
  const correctedPage = await resultPage(correctedResult.id);
  assert.equal(correctedPage.total_rows, EXPECTED_COUNT - 1);
  assertRow(correctedPage.measurements[0], 2, 128 ** 2, 200);
  assertRow(correctedPage.measurements[CORNER_LABEL - 2], CORNER_LABEL, 24 ** 2, 900);
  assertRow((await resultPage(adoptedResult.id)).measurements[0], 1, EXPECTED_L_AREA, 600);
  await selectedViewportReady();
  await checkpoint("corrected-adopted-result");
  await selectedInspector.getByRole("button", { name: "Undo removal" }).click();
  await waitFor(async () => (await snapshot()).selections.some((entry) => entry.id === originalSource.id && entry.data.result_id === adoptedResult.id), "parent history selection");
  await selectedViewportReady();
  await selectedInspector.getByRole("button", { name: "Redo removal" }).click();
  await waitFor(async () => (await snapshot()).selections.some((entry) => entry.id === originalSource.id && entry.data.result_id === correctedResult.id), "child history selection");
  await selectedViewportReady();

  stage = "review and durable export of corrected result";
  const inspector = page.getByRole("region", { name: "Large result objects" });
  await inspector.getByRole("button", { name: "Mark reviewed" }).click();
  await waitFor(async () => (await snapshot()).results.find((item) => item.id === correctedResult.id)?.review?.disposition === "reviewed", "exact correction review");
  await inspector.getByRole("button", { name: "Export revision" }).click();
  await waitFor(() => fs.access(path.join(exportPath, "manifest.json")).then(() => true, () => false), "published export", 900_000);
  await waitFor(() => inspector.getByRole("button", { name: "Export revision" }).isEnabled(), "export completion", 120_000);
  const exportJob = await waitFor(async () => (await snapshot()).jobs.find((job) => job.operation === "large_result_export" && ["succeeded", "failed"].includes(job.state)), "durable export resolution", 120_000);
  assert.equal(exportJob?.state, "succeeded", `Durable export did not succeed: ${exportJob?.error}`);

  const exportedManifestPath = path.join(exportPath, "manifest.json");
  const exportedManifest = JSON.parse(await fs.readFile(exportedManifestPath, "utf8"));
  assert.equal(exportedManifest.result_id, correctedResult.id);
  assert.equal(exportedManifest.revision_hash, correctedResult.revision_hash);
  assert.ok(exportedManifest.files.some((f) => f.name === "image.ome.tif"));
  assert.ok(exportedManifest.files.some((f) => f.name === "labels.ome.tif"));
  assert.ok(exportedManifest.files.some((f) => f.name === "objects.sqlite3"));
  assert.ok(exportedManifest.files.some((f) => f.name === "objects.csv"));

  // Independent readback and validation of exported artifacts
  const exportedResultDoc = JSON.parse(await fs.readFile(path.join(exportPath, "result.json"), "utf8"));
  assert.equal(exportedResultDoc.result.id, correctedResult.id);
  assert.equal(exportedResultDoc.result.revision_hash, correctedResult.revision_hash);
  assert.notEqual(exportedResultDoc.result.label_sha256, remoteRecord.result.label_sha256);
  assert.equal(exportedResultDoc.result.object_count, EXPECTED_COUNT - 1);
  assert.equal(exportedResultDoc.result.source_sha256, fixtureBefore.sha256);
  assert.equal(exportedResultDoc.label_value_sha256, exportedResultDoc.result.label_sha256);
  assert.equal(exportedResultDoc.review.disposition, "reviewed");
  assert.deepEqual(exportedResultDoc.result.provenance.selection, adoptedPage.provenance.selection);
  assert.deepEqual(exportedResultDoc.result.provenance.geometry, adoptedPage.provenance.geometry);
  assert.deepEqual(exportedResultDoc.result.provenance.remote_exchange, adoptedPage.provenance.remote_exchange);
  const ancestor = JSON.parse(await fs.readFile(path.join(exportPath, `ancestor-${adoptedResult.id}.json`), "utf8"));
  assert.equal(ancestor.revision_hash, adoptedResult.revision_hash);
  assert.equal(ancestor.object_count, EXPECTED_COUNT);
  assert.equal(ancestor.source_sha256, fixtureBefore.sha256);
  verification.corrected_export = await verifyNumerics("export", exportPath, null, true);
  assert.equal(verification.corrected_export.result_id, correctedResult.id);

  exportIdentity = {
    manifest: await fileIdentity(exportedManifestPath),
    result: await fileIdentity(path.join(exportPath, "result.json")),
    objects_sqlite3: await fileIdentity(path.join(exportPath, "objects.sqlite3")),
    objects_csv: await fileIdentity(path.join(exportPath, "objects.csv")),
  };
  await checkpoint("exported-adopted-result");

  stage = "save study and cold reopen";
  await page.getByRole("button", { name: "Save study", exact: true }).click();
  await waitFor(() => fs.access(path.join(studyPath, "study.sqlite3")).then(() => true, () => false), "saved study", 900_000);
  await waitFor(async () => (await page.evaluate(() => window.lociResearch.sessionState())).storage === "saved", "saved session adoption", 120_000);
  const savedSelection = (await snapshot()).selections.find((entry) => entry.id === originalSource.id);
  assert.equal(savedSelection.data.result_id, correctedResult.id);
  assert.equal(savedSelection.data.revision_hash, correctedResult.revision_hash);
  await checkpoint("saved-exchange-study");

  runtime = await app.evaluate(({ app: electronApp }) => ({ version: electronApp.getVersion(), electron: process.versions.electron, platform: process.platform }));
  await close(app);
  app = undefined;
  page = undefined;

  // Reopen
  stage = "cold reopen";
  ({ instance: app, window: page } = await launch(reopenUserData, rendererMessages.reopen));
  await startMemorySampler(app, "reopen");
  await electronMemorySnapshot("reopen-empty-before-open");
  await installDialogs(app, true);
  assert.equal(await page.locator("main.image-first-empty").isVisible(), true, "Cold reopen must start with an empty profile");
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 180_000 });

  const reopened = await snapshot();
  assert.equal(reopened.sources.length, 1);
  assert.equal(reopened.sources[0].id, originalSource.id);
  assert.equal(reopened.sources[0].sha256, fixtureBefore.sha256);
  assert.equal(reopened.results.length, 2);
  assert.equal(reopened.results.find((item) => item.id === adoptedResult.id)?.revision_hash, adoptedResult.revision_hash);
  const reopenedResult = reopened.results.find((item) => item.id === correctedResult.id);
  assert.equal(reopenedResult.revision_hash, correctedResult.revision_hash);
  assert.equal(reopenedResult.parent_id, adoptedResult.id);
  assert.equal(reopenedResult.review?.disposition, "reviewed");
  const reopenedSelection = reopened.selections.find((entry) => entry.id === originalSource.id);
  assert.equal(reopenedSelection.data.result_id, correctedResult.id);
  assert.equal(reopenedSelection.data.revision_hash, correctedResult.revision_hash);
  await page.locator(`[data-result-id="${correctedResult.id}"]`).click();
  await selectedViewportReady();
  const reopenedPage = await resultPage(reopenedResult.id);
  assert.equal(reopenedPage.total_rows, EXPECTED_COUNT - 1);
  assert.deepEqual(reopenedPage.provenance.selection, adoptedPage.provenance.selection);
  assert.deepEqual(reopenedPage.provenance.geometry, adoptedPage.provenance.geometry);
  assert.deepEqual(reopenedPage.provenance.remote_exchange, adoptedPage.provenance.remote_exchange);
  assertRow(reopenedPage.measurements[0], 2, 128 ** 2, 200);
  assertRow(reopenedPage.measurements[CORNER_LABEL - 2], CORNER_LABEL, 24 ** 2, 900);
  assertRow((await resultPage(adoptedResult.id)).measurements[0], 1, EXPECTED_L_AREA, 600);
  verification.reopened_child = await verifyNumerics("study", studyPath, correctedResult.id, true);
  verification.reopened_parent = await verifyNumerics("study", studyPath, adoptedResult.id);
  await checkpoint("cold-reopened-adopted-result");

  await close(app);
  app = undefined;
  page = undefined;

  stage = "final verification";
  assert.deepEqual(await fileIdentity(fixturePath), fixtureBefore, "Synthetic source bytes changed");
  assert.deepEqual(await fileIdentity(path.join(remoteBundlePath, "manifest.json")), bundleBefore.manifest, "Remote bundle manifest changed");
  for (const entry of manifest.files) {
    const identity = await fileIdentity(path.join(remoteBundlePath, entry.name));
    assert.deepEqual(identity, { sha256: entry.sha256, bytes: entry.size_bytes }, `Remote bundle ${entry.name} changed`);
  }
  assert.deepEqual({ executable: await executableIdentity(executablePath), worker: await executableIdentity(workerPath), asar: await fileIdentity(archivePath) }, packageBefore, "Packaged app changed during qualification");
  assert.deepEqual(rendererMessages.initial, [], "Initial renderer logged an error");
  assert.deepEqual(rendererMessages.reopen, [], "Reopened renderer logged an error");
  assert.deepEqual(dialogCalls, [
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "open", title: "Choose exported large result bundle directory" },
    { kind: "open", title: "Choose exported large result bundle directory" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "save", title: "Save research study as" },
    { kind: "open", title: "Open research study" },
  ]);
  assert.equal(memoryRuns.length, 2, "Both packaged launches need process-tree samples");
  for (const memory of memoryRuns) {
    assert.ok(memory.sample_count > 5, "Insufficient process-tree memory samples");
    assert.deepEqual(memory.errors, [], "Process-tree sampling failed");
    assert.ok(memory.processes.some((entry) => entry.name === "loci-engine"), "Worker was not observed");
  }

  const receipt = {
    schema: "loci.large-result-exchange-qa/v1",
    status: "passed",
    invocation: { command: "node desktop/tests/large-result-exchange.qa.mjs", app_bundle: appBundle, fixture: fixturePath, remote_bundle: remoteBundlePath, output: runRoot },
    source: sourceIdentity,
    package: packageBefore,
    fixture: fixtureBefore,
    remote_bundle: bundleBefore,
    remote_producer_claims: remoteProducer,
    runtime,
    hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, memory_bytes: os.totalmem() },
    actual: {
      source_sha256: originalSource.sha256,
      adopted_result: { id: adoptedResult.id, revision_hash: adoptedResult.revision_hash, object_count: adoptedResult.object_count },
      corrected_result: { id: correctedResult.id, revision_hash: correctedResult.revision_hash, object_count: correctedResult.object_count },
      saved_selection: savedSelection.data,
      export: exportIdentity,
    },
    cancellation,
    numerical_verification: verification,
    memory: { method: "500 ms sampled app process-tree RSS plus Electron checkpoint working sets", process_tree_runs: memoryRuns, electron_checkpoints: electronMemory },
    renderer_messages: rendererMessages,
    dialog_calls: dialogCalls,
    screenshots: (await fs.readdir(screenshots)).sort(),
    timing: { started_at: startedAt, elapsed_seconds: (performance.now() - started) / 1000, checkpoints },
  };

  await writeJson(path.join(runRoot, "qa-report.json"), receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  await electronMemorySnapshot("failure");
  await stopMemorySampler();
  const failure = {
    schema: "loci.large-result-exchange-qa-failure/v1",
    status: "failed",
    stage,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
    source: sourceIdentity,
    package: packageBefore,
    fixture: fixtureBefore,
    remote_bundle: bundleBefore,
    remote_producer_claims: remoteProducer,
    result_ids: { adopted: adoptedResult?.id, corrected: correctedResult?.id },
    cancellation,
    numerical_verification: verification,
    memory: { process_tree_runs: memoryRuns, electron_checkpoints: electronMemory },
    renderer_messages: rendererMessages,
    dialog_calls: dialogCalls,
    timing: { started_at: startedAt, elapsed_seconds: (performance.now() - started) / 1000, checkpoints },
  };
  if (page) {
    failure.screenshot = await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).then(() => "screenshots/failure.png", () => null);
    failure.ui_text = await page.locator("body").innerText().catch(() => "UI unavailable");
  }
  if (app) await collectDialogs(app);
  await writeJson(path.join(runRoot, "qa-failure.json"), failure);
  process.stderr.write(JSON.stringify(failure, null, 2) + "\n");
  throw error;
} finally {
  await stopMemorySampler();
  if (app) await app.close().catch(() => undefined);
}
