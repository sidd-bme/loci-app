/** Packaged, synthetic-only M6 large-result journey. Run after source and package qualification. */
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
const CORNER_LABEL = 34; // The 32 y=64 cells precede the y=500 corner.
const CENTER_LABEL = 531; // Cell (16,16), following the first 16 rows and corner insertion.
const CENTER_VALUE = 200 + (16 * 32 + 16) % 400;
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
function assertClose(actual, expected, label, tolerance = 1e-9) {
  assert.equal(typeof actual, "number", label);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

// ps reports RSS in KiB. Keep only executable basenames, never command arguments
// or paths, in the incremental evidence file.
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
          if (observations.has(entry.pid)) summary.processes.push(observations.get(entry.pid));
          observations.set(entry.pid, observation);
        }
        observation.sampled_peak_rss_bytes = Math.max(observation.sampled_peak_rss_bytes, entry.rss_bytes);
        observation.samples++;
      }
      previousPids = currentPids;
      if (summary.tree_first_observed_rss_bytes === null) summary.tree_first_observed_rss_bytes = total;
      summary.tree_sampled_peak_rss_bytes = Math.max(summary.tree_sampled_peak_rss_bytes ?? total, total);
      const phase = summary.phase_samples[stage] ?? { samples: 0, first_tree_rss_bytes: total, sampled_peak_tree_rss_bytes: total };
      phase.samples++;
      phase.sampled_peak_tree_rss_bytes = Math.max(phase.sampled_peak_tree_rss_bytes, total);
      summary.phase_samples[stage] = phase;
      summary.sample_count++;
      if (summary.sample_count % 4 === 1) {
        const diskStarted = performance.now();
        const { stdout: disk } = await run("du", ["-sk", runRoot], { timeout: 10_000 });
        const allocatedBytes = Number(disk.trim().split(/\s+/)[0]) * 1024;
        assert.ok(Number.isFinite(allocatedBytes) && allocatedBytes > 0, "Disk sampler returned invalid allocation");
        summary.disk_samples.push({ phase: stage, elapsed_seconds: elapsedMs / 1000, allocated_bytes: allocatedBytes, duration_ms: performance.now() - diskStarted });
        summary.sampled_peak_run_directory_bytes = Math.max(summary.sampled_peak_run_directory_bytes, allocatedBytes);
      }
      await handle.write(JSON.stringify({ elapsed_seconds: elapsedMs / 1000, phase: stage, interval_ms: intervalMs, root_pid: rootPid, tree_rss_bytes: total, processes }) + "\n");
    } catch (error) {
      summary.failed_samples++;
      const failure = { elapsed_seconds: elapsedMs / 1000, phase: stage, kind: "sample_error", name: error?.name ?? "Error", code: error?.code ?? null };
      summary.errors.push(failure);
      await handle.write(JSON.stringify(failure) + "\n").catch(() => undefined);
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
      // Electron MemoryInfo values are KiB; the receipt stores bytes.
      working_set_bytes: Number.isFinite(metric.memory?.workingSetSize) ? metric.memory.workingSetSize * 1024 : null,
      peak_working_set_bytes: Number.isFinite(metric.memory?.peakWorkingSetSize) ? metric.memory.peakWorkingSetSize * 1024 : null,
    })));
    electronMemory.push({ checkpoint, elapsed_seconds: (performance.now() - started) / 1000, processes });
  } catch (error) {
    electronMemory.push({ checkpoint, elapsed_seconds: (performance.now() - started) / 1000, error: { name: error?.name ?? "Error", code: error?.code ?? null } });
  }
}

// No fixture or package is built here. The fixture must be the synthetic 16384²
// output of scripts/qualify-large-results.py --side 16384 --phase fixture.
const appBundle = requiredPath("LOCI_PACKAGED_APP");
const outputRoot = requiredPath("LOCI_QA_OUTPUT_ROOT");
const fixturePath = requiredPath("LOCI_QA_LARGE_FIXTURE");
assert.equal(process.platform, "darwin", "This packaged journey is qualified for macOS only.");
assert.equal(inside(outputRoot, fixturePath), false, "The source fixture must be outside QA output.");
assert.equal(inside(appBundle, outputRoot), false, "QA output must not alter the packaged app.");
assert.equal(path.basename(fixturePath), "source.ome.tif", "Use the named synthetic qualification fixture.");
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const workerPath = path.join(appBundle, "Contents", "Resources", "loci-engine", "loci-engine");
const archivePath = path.join(appBundle, "Contents", "Resources", "app.asar");
const runName = `large-result-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
const runRoot = path.join(outputRoot, runName);
const screenshots = path.join(runRoot, "screenshots");
const userData = path.join(runRoot, "user-data");
const reopenUserData = path.join(runRoot, "reopen-user-data");
const studyPath = path.join(runRoot, "saved-large.loci-study");
const exportPath = path.join(runRoot, "reviewed-large-result");
await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(runRoot);
await Promise.all([fs.mkdir(screenshots), fs.mkdir(userData), fs.mkdir(reopenUserData)]);

let packageBefore;
let fixtureBefore;
let sourceIdentity;
let runtime;
let parentResult;
let correctedResult;
let originalSource;
let exportIdentity;
let responsiveness;
let cancellation;
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
  }, { fixture: fixturePath, study: studyPath, export: exportPath, reopening });
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
async function pageTo(offset) {
  const next = page.getByRole("region", { name: "Large result objects" }).getByRole("button", { name: "Next", exact: true });
  const previous = page.getByRole("region", { name: "Large result objects" }).getByRole("button", { name: "Previous", exact: true });
  const pageStatus = page.locator(".large-object-page").first().getByRole("status");
  const current = Number((await pageStatus.innerText()).split("–")[0]) - 1;
  assert.ok(Number.isInteger(current) && current >= 0 && current % 200 === 0, "Invalid object page cursor");
  for (let cursor = current; cursor !== offset;) {
    const forward = cursor < offset;
    await (forward ? next : previous).click();
    cursor += forward ? 200 : -200;
    await waitFor(async () => (await pageStatus.innerText()).startsWith(String(cursor + 1) + "–"), "object page cursor");
  }
}
function assertRow(row, label, count, value) {
  assert.equal(row.label, label);
  assert.equal(row.voxel_count, count);
  assertClose(row.measure, count * .375, `area for object ${label}`);
  assert.equal(row.measure_unit, "um^2");
  const intensity = Object.values(row.intensity);
  assert.equal(intensity.length, 1);
  assert.equal(intensity[0].sum, count * value);
  assert.equal(intensity[0].mean, value);
  assert.equal(intensity[0].std_population, 0);
}
async function assertNoOverflow(name) {
  const layout = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    overflow_x: document.documentElement.scrollWidth - innerWidth,
    overflow_y: document.documentElement.scrollHeight - innerHeight,
  }));
  assert.ok(layout.overflow_x <= 1 && layout.overflow_y <= 1, `${name}: global overflow ${JSON.stringify(layout)}`);
  return layout;
}

try {
  stage = "input identities";
  packageBefore = {
    executable: await executableIdentity(executablePath),
    worker: await executableIdentity(workerPath),
    asar: await fileIdentity(archivePath),
  };
  fixtureBefore = await fileIdentity(fixturePath);
  const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = {
    head: await git("rev-parse", "HEAD"),
    tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"),
    harness_sha256: await sha256(new URL(import.meta.url)),
    fixture_generator_sha256: await sha256(path.join(projectRoot, "scripts", "qualify-large-results.py")),
  };
  assert.equal(await fs.access(studyPath).then(() => true, () => false), false);
  assert.equal(await fs.access(exportPath).then(() => true, () => false), false);

  stage = "launch and import";
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
  await checkpoint("imported-source-1280x900");

  stage = "large preflight and run";
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("large-components");
  assert.equal(await page.getByLabel("Large image threshold").inputValue(), "100");
  await page.getByRole("button", { name: "Segment large image" }).waitFor({ state: "visible" });
  await waitFor(() => page.getByRole("button", { name: "Segment large image" }).isEnabled(), "large preflight", 180_000);
  assert.match(await page.getByRole("region", { name: "Large image analysis" }).innerText(), /Working allowance\s+256 MiB/);
  await checkpoint("large-preflight");
  stage = "early cancellation";
  await page.getByRole("button", { name: "Segment large image" }).click();
  const firstJob = await waitFor(async () => {
    const state = await snapshot();
    return state.jobs.find((job) => job.operation === "large_components_run" && job.state === "running");
  }, "durable running large job", 120_000);
  assert.equal((await snapshot()).results.length, 0, "A running job published a result before cancellation");
  const runningObserved = performance.now();
  await page.waitForTimeout(2_000);
  const stillRunning = (await snapshot()).jobs.find((job) => job.id === firstJob.id);
  assert.equal(stillRunning?.state, "running", "The cancellation sample must target an active job");
  await page.getByRole("button", { name: /Jobs/ }).click();
  const jobRow = page.getByRole("region", { name: "Job center" }).locator(".workbench-jobs__row").filter({ hasText: firstJob.id.slice(0, 8) });
  await jobRow.getByRole("button", { name: "Cancel" }).waitFor({ state: "visible", timeout: 15_000 });
  const cancelRequested = performance.now();
  await jobRow.getByRole("button", { name: "Cancel" }).click();
  let cancelled;
  const cancelDeadline = cancelRequested + 5_000;
  while (performance.now() < cancelDeadline) {
    const state = await snapshot();
    cancelled = state.jobs.find((job) => job.id === firstJob.id);
    if (cancelled?.state === "cancelled") {
      assert.equal(state.results.length, 0, "Cancelled run published a result");
      break;
    }
    await page.waitForTimeout(100);
  }
  const cancelElapsed = performance.now() - cancelRequested;
  assert.equal(cancelled?.state, "cancelled", `Cancellation exceeded five seconds; last state ${cancelled?.state}`);
  assert.ok(cancelElapsed <= 5_000, `Cancellation took ${cancelElapsed} ms`);
  cancellation = {
    job_id: firstJob.id, request_key: firstJob.request_key,
    running_observed_seconds: (runningObserved - started) / 1000,
    cancel_requested_seconds: (cancelRequested - started) / 1000,
    latency_ms: cancelElapsed, final_state: cancelled.state, published_results: 0,
  };
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.includes("Segment large image"));
    return button && !button.disabled;
  }, undefined, { timeout: 30_000 });
  const cancellationAlert = page.locator(".research-alert[role=alert]");
  if (await cancellationAlert.isVisible().catch(() => false)) {
    assert.match((await cancellationAlert.innerText()).toLowerCase(), /cancel/);
    await cancellationAlert.getByRole("button", { name: "Dismiss" }).click();
  }
  await checkpoint("cancelled-large-job-no-result");
  assert.equal((await snapshot()).results.length, 0);
  await page.getByRole("button", { name: /Jobs/ }).click();

  stage = "fresh large retry";
  await page.evaluate(() => {
    const metric = { frames: 0, max_gap_ms: 0, key_events: 0, started: performance.now(), previous: performance.now() };
    const frame = (time) => { metric.frames++; metric.max_gap_ms = Math.max(metric.max_gap_ms, time - metric.previous); metric.previous = time; if (!metric.stopped) requestAnimationFrame(frame); };
    document.addEventListener("keydown", () => { metric.key_events++; });
    window.__lociLargeQaFrame = metric;
    requestAnimationFrame(frame);
  });
  await page.getByRole("button", { name: "Segment large image" }).click();
  const retryJob = await waitFor(async () => {
    const state = await snapshot();
    return state.jobs.find((job) => job.operation === "large_components_run" && job.id !== firstJob.id && ["queued", "running", "succeeded"].includes(job.state));
  }, "fresh retry job", 120_000);
  assert.notEqual(retryJob.request_key, firstJob.request_key, "Retry reused the cancelled submission");
  cancellation.retry_job_id = retryJob.id;
  const runDeadline = Date.now() + 30 * 60_000;
  while (Date.now() < runDeadline) {
    await noUiError("large run");
    const state = await snapshot();
    const candidate = state.results.find((item) => item.kind === "large-components" && item.source_id === originalSource.id);
    if (candidate) { parentResult = candidate; break; }
    const t = performance.now();
    await page.keyboard.press("Tab", { timeout: 15_000 });
    inputRoundTrips.push(performance.now() - t);
    await page.waitForTimeout(1_500);
  }
  assert.ok(parentResult, "Large run did not publish a result before its deadline");
  responsiveness = await page.evaluate(() => {
    const metric = window.__lociLargeQaFrame;
    metric.stopped = true;
    return { frames: metric.frames, max_raf_gap_ms: metric.max_gap_ms, key_events: metric.key_events, seconds: (performance.now() - metric.started) / 1000 };
  });
  assert.ok(responsiveness.frames > 0 && inputRoundTrips.length > 0 && responsiveness.key_events > 0, "Renderer responsiveness probes did not run");
  const sortedInputs = [...inputRoundTrips].sort((a, b) => a - b);
  responsiveness.input_p95_ms = sortedInputs[Math.ceil(sortedInputs.length * .95) - 1];
  assert.ok(responsiveness.input_p95_ms <= 1_000 && Math.max(...inputRoundTrips) <= 2_000,
    "Renderer input exceeded the interactive latency gate during the run");
  assert.equal(parentResult.schema, "loci.research-result/v2");
  assert.equal(parentResult.object_count, EXPECTED_COUNT);
  assert.equal(parentResult.source_id, originalSource.id);
  assert.equal(parentResult.source_sha256, fixtureBefore.sha256);
  assert.equal(parentResult.working_bytes, ALLOWANCE);
  assert.deepEqual(parentResult.arrays.image.shape, [SIDE, SIDE]);
  assert.deepEqual(parentResult.arrays.labels.shape, [SIDE, SIDE]);
  assert.equal(parentResult.arrays.image.dtype, "uint16");
  assert.equal(parentResult.arrays.labels.dtype, "uint32");
  const parentPage = await resultPage(parentResult.id);
  assert.equal(parentPage.total_rows, EXPECTED_COUNT);
  assert.equal(parentPage.provenance.recipe.working_bytes, ALLOWANCE);
  assert.equal(parentPage.provenance.job_id, retryJob.id, "Published result was not the explicit fresh retry");
  assert.equal(parentPage.provenance.measurement_basis, "raw-selected-channel-values-on-result-grid");
  assert.equal(parentPage.provenance.execution_policy.core_size, 512);
  assert.equal(parentPage.provenance.execution_policy.connectivity, 4);
  assert.equal(parentPage.provenance.segmentation.threshold, 100);
  assert.deepEqual(parentPage.provenance.selection, { x: 0, y: 0, width: SIDE, height: SIDE, t: 0, c: 0, z: 0, level: 0 });
  assertRow(parentPage.measurements[0], 1, EXPECTED_L_AREA, 600);
  assertRow(parentPage.measurements[1], 2, 128 ** 2, 200);
  assertRow(parentPage.measurements[CORNER_LABEL - 1], CORNER_LABEL, 24 ** 2, 900);
  const jobsAfterRetry = (await waitFor(async () => {
    const next = await snapshot();
    return next.jobs.find((job) => job.id === retryJob.id)?.state === "succeeded" ? next : null;
  }, "succeeded fresh retry", 120_000)).jobs;
  assert.equal(jobsAfterRetry.find((job) => job.id === firstJob.id)?.state, "cancelled");
  assert.equal(jobsAfterRetry.find((job) => job.id === retryJob.id)?.state, "succeeded");
  await selectedViewportReady();
  await checkpoint("large-overview-and-first-page");

  stage = "pages and native detail";
  await pageTo(1_000);
  const lastObject = page.getByRole("region", { name: "Large result objects" }).getByRole("button", { name: "#1026" });
  await lastObject.scrollIntoViewIfNeeded();
  assert.equal(await lastObject.isVisible(), true);
  await checkpoint("large-last-page");
  const lastPage = await resultPage(parentResult.id, 1_000);
  assert.equal(lastPage.measurements.length, 26);
  assert.equal(lastPage.measurements.at(-1).label, 1_026);
  await pageTo(400);
  const centerPage = await resultPage(parentResult.id, 400);
  const center = centerPage.measurements.find((row) => row.label === CENTER_LABEL);
  assertRow(center, CENTER_LABEL, 128 ** 2, CENTER_VALUE);
  await page.getByRole("button", { name: `#${CENTER_LABEL}`, exact: true }).click();
  await page.getByRole("button", { name: "Inspect object pixels" }).click();
  const viewport = await selectedViewportReady();
  const nativeStart = Math.floor(center.centroid_index[1]) - 256;
  await waitFor(async () => (await viewport.locator(".large-result-caption").innerText()).includes(`X ${nativeStart}–${nativeStart + 511}`), "focused native region", 120_000);
  await viewport.getByRole("button", { name: "Zoom into large result" }).click();
  await selectedViewportReady();
  await viewport.getByRole("button", { name: "Zoom into large result" }).click();
  await selectedViewportReady();
  await viewport.getByRole("button", { name: "Zoom into large result" }).click();
  await selectedViewportReady();
  assert.match(await viewport.getByRole("status").innerText(), /Native pixels/);
  await checkpoint("native-center-object-detail");
  const nativeImage = viewport.getByRole("img", { name: "Selected quantitative result region" });
  const identicalPng = await nativeImage.getAttribute("src");
  const regionText = await viewport.locator(".large-result-caption").innerText();
  const regionMatch = /X (\d+)–(\d+), Y (\d+)–(\d+)/.exec(regionText);
  assert.ok(regionMatch, `Missing native region coordinates: ${regionText}`);
  let nativeX = Number(regionMatch[1]);
  assert.equal(Number(regionMatch[2]) - nativeX + 1, 64, "Native detail must be a 64-pixel region");
  await viewport.locator(".large-result-stage").focus();
  await viewport.locator(".large-result-stage").press("ArrowRight");
  nativeX += 16;
  await waitFor(async () => (await viewport.locator(".large-result-caption").innerText()).includes(`X ${nativeX}–${nativeX + 63}`), "first uniform pan");
  await selectedViewportReady();
  assert.equal(await nativeImage.getAttribute("src"), identicalPng, "The uniform object should yield the same PNG after bounded panning");
  await viewport.locator(".large-result-stage").press("ArrowRight");
  nativeX += 16;
  await waitFor(async () => (await viewport.locator(".large-result-caption").innerText()).includes(`X ${nativeX}–${nativeX + 63}`), "second uniform pan");
  await selectedViewportReady();
  assert.equal(await nativeImage.getAttribute("src"), identicalPng, "A second uniform pan should remain ready with identical PNG bytes");
  const bounds = await nativeImage.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  assert.ok(bounds.width >= 300 && bounds.height >= 300, "Native zoom must magnify the selected 64-pixel region");
  await nativeImage.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await waitFor(() => page.getByRole("region", { name: "Selected quantitative object" }).getByRole("heading", { name: `Object #${CENTER_LABEL}` }).isVisible(), "native object pick");

  stage = "whole-object correction and history";
  await pageTo(0);
  await page.getByRole("button", { name: "#1", exact: true }).click();
  await page.getByRole("button", { name: "Inspect object pixels" }).click();
  await selectedViewportReady();
  await waitFor(async () => (await viewport.locator(".large-result-caption").innerText()).includes("X 0–511, Y 0–511"), "concave object member region");
  await checkpoint("concave-object-native-pixels");
  await page.getByRole("button", { name: "Remove object in new revision" }).click();
  correctedResult = await waitFor(async () => {
    const next = await snapshot();
    return next.results.find((item) => item.parent_id === parentResult.id && item.kind === "large-corrected-labels");
  }, "immutable corrected result", 600_000);
  assert.equal(correctedResult.object_count, EXPECTED_COUNT - 1);
  assert.notEqual(correctedResult.revision_hash, parentResult.revision_hash);
  assert.equal(correctedResult.source_sha256, fixtureBefore.sha256);
  await selectedViewportReady();
  await checkpoint("corrected-result");
  const correctedPage = await resultPage(correctedResult.id);
  assert.equal(correctedPage.total_rows, EXPECTED_COUNT - 1);
  assertRow(correctedPage.measurements[0], 2, 128 ** 2, 200);
  assertRow(correctedPage.measurements[CORNER_LABEL - 2], CORNER_LABEL, 24 ** 2, 900);
  assertRow((await resultPage(parentResult.id)).measurements[0], 1, EXPECTED_L_AREA, 600);
  const inspector = page.getByRole("region", { name: "Large result objects" });
  await inspector.getByRole("button", { name: "Undo removal" }).click();
  await waitFor(async () => (await snapshot()).selections.some((entry) => entry.id === originalSource.id && entry.data.result_id === parentResult.id), "durable undo selection");
  await selectedViewportReady();
  await inspector.getByRole("button", { name: "Redo removal" }).click();
  await waitFor(async () => (await snapshot()).selections.some((entry) => entry.id === originalSource.id && entry.data.result_id === correctedResult.id), "durable redo selection");
  await selectedViewportReady();
  await checkpoint("redo-corrected-revision");

  stage = "review export and save";
  await inspector.getByRole("button", { name: "Mark reviewed" }).click();
  await waitFor(async () => (await snapshot()).results.find((item) => item.id === correctedResult.id)?.review?.disposition === "reviewed", "exact reviewed revision");
  await inspector.getByRole("button", { name: "Export revision" }).click();
  await waitFor(() => fs.access(path.join(exportPath, "manifest.json")).then(() => true, () => false), "published export", 900_000);
  await waitFor(() => inspector.getByRole("button", { name: "Export revision" }).isEnabled(), "export completion", 120_000);
  const exportRecord = JSON.parse(await fs.readFile(path.join(exportPath, "result.json"), "utf8"));
  const ancestor = JSON.parse(await fs.readFile(path.join(exportPath, `ancestor-${parentResult.id}.json`), "utf8"));
  assert.equal(exportRecord.schema, "loci.research-export/v2");
  assert.equal(exportRecord.result.id, correctedResult.id);
  assert.equal(exportRecord.result.revision_hash, correctedResult.revision_hash);
  assert.equal(exportRecord.result.object_count, EXPECTED_COUNT - 1);
  assert.equal(exportRecord.result.source_sha256, fixtureBefore.sha256);
  assert.equal(exportRecord.label_value_sha256, exportRecord.result.label_sha256);
  assert.match(exportRecord.result.label_sha256, /^[0-9a-f]{64}$/);
  assert.equal(exportRecord.result.provenance.recipe.working_bytes, ALLOWANCE);
  assert.equal(exportRecord.result.provenance.measurement_basis, "raw-selected-channel-values-on-result-grid");
  assert.equal(ancestor.revision_hash, parentResult.revision_hash);
  assert.equal(ancestor.object_count, EXPECTED_COUNT);
  assert.equal(ancestor.source_sha256, fixtureBefore.sha256);
  assert.notEqual(ancestor.label_sha256, exportRecord.result.label_sha256);
  const csv = await fs.readFile(path.join(exportPath, "objects.csv"), "utf8");
  assert.equal(csv.trimEnd().split(/\r?\n/).length, EXPECTED_COUNT);
  const manifestPath = path.join(exportPath, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.result_id, correctedResult.id);
  assert.equal(manifest.revision_hash, correctedResult.revision_hash);
  assert.ok(manifest.files.some((file) => file.name === "image.ome.tif"));
  assert.ok(manifest.files.some((file) => file.name === "labels.ome.tif"));
  assert.ok(manifest.files.some((file) => file.name === "objects.csv"));
  const exportedTable = await fileIdentity(path.join(exportPath, "objects.sqlite3"));
  assert.equal(exportedTable.sha256, exportRecord.result.object_table.sha256, "Exported rows changed from the immutable table");
  exportIdentity = { manifest: await fileIdentity(manifestPath), result: await fileIdentity(path.join(exportPath, "result.json")), object_csv: await fileIdentity(path.join(exportPath, "objects.csv")), object_table: exportedTable };
  await checkpoint("reviewed-exported-result");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1_000, height: 740 }));
  const compactLayout = await assertNoOverflow("1000x740 result");
  await checkpoint("result-1000x740");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1_280, height: 900 }));
  const normalLayout = await assertNoOverflow("1280x900 result");
  await page.getByRole("button", { name: "Save study", exact: true }).click();
  await waitFor(() => fs.access(path.join(studyPath, "study.sqlite3")).then(() => true, () => false), "saved study", 900_000);
  await waitFor(async () => (await page.evaluate(() => window.lociResearch.sessionState())).storage === "saved", "saved session adoption", 120_000);
  const savedSelection = (await snapshot()).selections.find((entry) => entry.id === originalSource.id);
  assert.equal(savedSelection.data.result_id, correctedResult.id);
  assert.equal(savedSelection.data.revision_hash, correctedResult.revision_hash);
  await close(app); app = undefined; page = undefined;

  stage = "cold reopen";
  ({ instance: app, window: page } = await launch(reopenUserData, rendererMessages.reopen));
  await startMemorySampler(app, "reopen");
  await electronMemorySnapshot("reopen-empty-before-study-open");
  await installDialogs(app, true);
  assert.equal(await page.locator("main.image-first-empty").isVisible(), true, "Cold reopen must start in a fresh session");
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 180_000 });
  const reopened = await snapshot();
  assert.equal(reopened.sources.length, 1);
  assert.equal(reopened.sources[0].id, originalSource.id);
  assert.equal(reopened.sources[0].sha256, fixtureBefore.sha256);
  assert.equal(reopened.results.find((item) => item.id === parentResult.id)?.revision_hash, parentResult.revision_hash);
  assert.equal(reopened.results.find((item) => item.id === correctedResult.id)?.revision_hash, correctedResult.revision_hash);
  const reopenedSelection = reopened.selections.find((entry) => entry.id === originalSource.id);
  assert.equal(reopenedSelection.data.result_id, correctedResult.id);
  assert.equal(reopenedSelection.data.revision_hash, correctedResult.revision_hash);
  await page.locator(`[data-result-id="${correctedResult.id}"]`).click();
  await selectedViewportReady();
  await selectWorkbenchTool(page, "Info");
  const reopenedPage = await resultPage(correctedResult.id);
  assert.equal(reopenedPage.total_rows, EXPECTED_COUNT - 1);
  assertRow(reopenedPage.measurements[0], 2, 128 ** 2, 200);
  assertRow(reopenedPage.measurements[CORNER_LABEL - 2], CORNER_LABEL, 24 ** 2, 900);
  assertRow((await resultPage(parentResult.id)).measurements[0], 1, EXPECTED_L_AREA, 600);
  assert.equal(reopened.results.find((item) => item.id === correctedResult.id).review.disposition, "reviewed");
  await checkpoint("cold-reopened-exact-revision");
  runtime = await app.evaluate(({ app: electronApp }) => ({ version: electronApp.getVersion(), electron: process.versions.electron, platform: process.platform }));
  await close(app); app = undefined; page = undefined;

  stage = "final identities";
  assert.deepEqual(await fileIdentity(fixturePath), fixtureBefore, "Synthetic source bytes changed");
  assert.deepEqual({ executable: await executableIdentity(executablePath), worker: await executableIdentity(workerPath), asar: await fileIdentity(archivePath) }, packageBefore, "Packaged app changed during qualification");
  assert.deepEqual(rendererMessages.initial, [], "Initial renderer logged an error");
  assert.deepEqual(rendererMessages.reopen, [], "Reopened renderer logged an error");
  const expectedDialogs = [
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "save", title: "Save research study as" },
    { kind: "open", title: "Open research study" },
  ];
  assert.deepEqual(dialogCalls, expectedDialogs);
  assert.equal(memoryRuns.length, 2, "Both packaged launches require memory evidence");
  for (const memory of memoryRuns) {
    assert.ok(memory.sample_count > 5, "Insufficient process-tree memory samples");
    assert.deepEqual(memory.errors, [], "Resource sampling failed");
    assert.ok(memory.processes.some((entry) => entry.name === "loci-engine"), "No Python worker was observed");
    assert.ok(memory.disk_samples.length > 0, "Missing sampled disk allocation");
  }
  const receipt = {
    schema: "loci.large-result-packaged-qa/v1", status: "passed",
    invocation: { command: "node desktop/tests/large-result-workflow.qa.mjs", app_bundle: appBundle, fixture: fixturePath, output: runRoot },
    source: sourceIdentity, package: packageBefore, fixture: fixtureBefore,
    runtime, hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, memory_bytes: os.totalmem() },
    expected: { side: SIDE, threshold: 100, objects: EXPECTED_COUNT, corrected_objects: EXPECTED_COUNT - 1, working_bytes: ALLOWANCE },
    actual: { source_sha256: originalSource.sha256, parent_result: { id: parentResult.id, revision_hash: parentResult.revision_hash }, corrected_result: { id: correctedResult.id, revision_hash: correctedResult.revision_hash, effective_label_sha256: exportRecord.result.label_sha256 }, saved_selection: savedSelection.data, export: exportIdentity },
    cancellation,
    memory: { method: "500 ms sampled app process-tree RSS plus Electron checkpoint working sets", ps_rss_unit: "bytes converted from KiB", electron_working_set_unit: "bytes converted from KiB", process_tree_runs: memoryRuns, electron_checkpoints: electronMemory },
    responsiveness: { ...responsiveness, input_round_trip_ms: inputRoundTrips, max_input_round_trip_ms: Math.max(...inputRoundTrips) },
    layouts: { normal: normalLayout, compact: compactLayout }, renderer_messages: rendererMessages,
    dialog_calls: dialogCalls, screenshots: (await fs.readdir(screenshots)).sort(),
    timing: { started_at: startedAt, elapsed_seconds: (performance.now() - started) / 1000, checkpoints },
  };
  await writeJson(path.join(runRoot, "qa-report.json"), receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  await electronMemorySnapshot("failure");
  await stopMemorySampler();
  const failure = {
    schema: "loci.large-result-packaged-qa-failure/v1", status: "failed", stage,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
    source: sourceIdentity, package: packageBefore, fixture: fixtureBefore,
    result_ids: { parent: parentResult?.id, corrected: correctedResult?.id },
    cancellation,
    responsiveness: { ...responsiveness, input_round_trip_ms: inputRoundTrips },
    memory: { method: "500 ms sampled app process-tree RSS plus Electron checkpoint working sets", ps_rss_unit: "bytes converted from KiB", electron_working_set_unit: "bytes converted from KiB", process_tree_runs: memoryRuns, electron_checkpoints: electronMemory },
    renderer_messages: rendererMessages, dialog_calls: dialogCalls,
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
