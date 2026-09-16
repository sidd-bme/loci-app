import assert from "node:assert/strict";
import { createEmptyStudy, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
if (process.platform !== "darwin") {
  throw new Error("Temporal split/merge packaged QA currently requires macOS.");
}

const appBundle = path.resolve(
  process.env.LOCI_PACKAGED_APP ??
    path.join(desktopRoot, "..", ".loci", "builds", "current", "Loci.app",),
);
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const resourcesPath = path.join(appBundle, "Contents", "Resources");
const workerPath = path.join(resourcesPath, "loci-engine", "loci-engine");
const archivePath = path.join(resourcesPath, "app.asar");
const fixturePython = path.resolve(
  process.env.LOCI_QA_FIXTURE_PYTHON ??
    path.join(projectRoot, "engine", ".venv", "bin", "python"),
);
const runName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(projectRoot, ".loci", "qa"),
  `temporal-split-merge-${runName}`,
);
const fixturePath = path.join(outputRoot, "fixture", "synthetic-split-merge.ome.tiff");
const studyPath = path.join(outputRoot, "study", "temporal-split-merge.loci-study");
const exportPath = path.join(outputRoot, "export", "reviewed-temporal-result");
const screenshotsPath = path.join(outputRoot, "screenshots");
const reportPath = path.join(outputRoot, "qa-report.json");
const failurePath = path.join(outputRoot, "qa-failure.json");
const startedAt = new Date().toISOString();
const startedClock = performance.now();

await Promise.all([
  fs.mkdir(path.dirname(fixturePath), { recursive: true }),
  fs.mkdir(path.dirname(studyPath), { recursive: true }),
  fs.mkdir(path.dirname(exportPath), { recursive: true }),
  fs.mkdir(screenshotsPath, { recursive: true }),
  fs.access(executablePath, constants.X_OK),
  fs.access(workerPath, constants.X_OK),
  fs.access(archivePath, constants.R_OK),
  fs.access(fixturePython, constants.X_OK),
]);

const fixtureProgram = String.raw`
from pathlib import Path
import numpy as np
import tifffile

destination = Path(__import__("sys").argv[1])
pixels = np.zeros((3, 64, 64), dtype=np.uint16)
pixels[0, 28:36, 28:36] = 1000
pixels[1, 28:36, 20:28] = 1000
pixels[1, 28:36, 36:44] = 1000
pixels[2, 28:36, 28:36] = 1000
tifffile.imwrite(
    destination,
    pixels,
    ome=True,
    photometric="minisblack",
    metadata={
        "axes": "TYX",
        "Name": "Synthetic split and merge candidates",
        "PhysicalSizeX": 1.0,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeY": 1.0,
        "PhysicalSizeYUnit": "µm",
        "TimeIncrement": 4.0,
        "TimeIncrementUnit": "s",
    },
)
`;
await run(fixturePython, ["-c", fixtureProgram, fixturePath], {
  cwd: projectRoot,
  timeout: 60_000,
  windowsHide: true,
});

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function fileIdentity(file) {
  const stat = await fs.lstat(file);
  assert.equal(stat.isFile(), true, `Expected a regular file: ${file}`);
  assert.equal(stat.isSymbolicLink(), false, `Expected no symlink: ${file}`);
  return { sha256: await sha256(file), size_bytes: stat.size };
}

async function buildIdentity() {
  return {
    executable: await fileIdentity(executablePath),
    worker: await fileIdentity(workerPath),
    app_asar: await fileIdentity(archivePath),
  };
}

const [buildBefore, fixtureBefore, harnessSha256] = await Promise.all([
  buildIdentity(),
  fileIdentity(fixturePath),
  sha256(import.meta.filename),
]);
const git = async (...args) =>
  (await run("git", args, { cwd: projectRoot, timeout: 30_000 })).stdout.trim();
const sourceTree = {
  head: await git("rev-parse", "HEAD"),
  tree: await git("rev-parse", "HEAD^{tree}"),
  status: await git("status", "--porcelain"),
  harness_sha256: harnessSha256,
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
  }
}

async function waitFor(page, read, accept, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    await noUiError(page, label);
    value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function visible(page, locator, label, timeout = 120_000) {
  await locator.waitFor({ state: "visible", timeout });
  await noUiError(page, `waiting for ${label}`);
  return locator;
}

async function screenshot(page, name) {
  const file = path.join(screenshotsPath, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return path.basename(file);
}

async function launch(userData, rendererMessages) {
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      rendererMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    rendererMessages.push({ type: "pageerror", text: String(error) });
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 900 });
  });
  return { app, page };
}

async function close(app) {
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
}

async function installDialogs(app, mode) {
  await app.evaluate(
    ({ dialog }, values) => {
      globalThis.__lociTemporalQaDialogs = [];
      const record = (kind, title) =>
        globalThis.__lociTemporalQaDialogs.push({ kind, title });
      dialog.showOpenDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("open", title);
        if (title === "Add microscopy or medical images" && values.mode === "initial") {
          return { canceled: false, filePaths: [values.fixture] };
        }
        if (title === "Open research study" && values.mode === "reopen") {
          return { canceled: false, filePaths: [values.study] };
        }
        throw new Error(`Unexpected native open dialog: ${String(title)}`);
      };
      dialog.showSaveDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("save", title);
        if (title === "Create research study" && values.mode === "initial") {
          return { canceled: false, filePath: values.study };
        }
        if (title === "Export reviewed result bundle" && values.mode === "initial") {
          return { canceled: false, filePath: values.exportPath };
        }
        throw new Error(`Unexpected native save dialog: ${String(title)}`);
      };
      dialog.showMessageBox = async (...args) => {
        const title = args.at(-1)?.title;
        record("message", title);
        return { response: 0, checkboxChecked: false };
      };
    },
    { fixture: fixturePath, study: studyPath, exportPath, mode },
  );
}

const snapshot = (page) => page.evaluate(() => window.lociResearch.getSnapshot());
const trackingResult = (page, result) =>
  page.evaluate(
    (item) =>
      window.lociResearch.execute("tracking_result", {
        result_id: item.id,
        revision_hash: item.revision_hash,
      }),
    result,
  );

async function openResearch(page) {
  await visible(page, page.locator("main.image-first-empty, main.image-first-workbench"), "application shell");
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
}

async function newResult(page, action, kind) {
  const before = new Set((await snapshot(page)).results.map((item) => item.id));
  await action();
  const state = await waitFor(
    page,
    () => snapshot(page),
    (value) =>
      value.results.some(
        (item) => !before.has(item.id) && (!kind || item.kind === kind),
      ),
    `new ${kind ?? "result"}`,
  );
  const result = state.results.find(
    (item) => !before.has(item.id) && (!kind || item.kind === kind),
  );
  await waitFor(
    page,
    () => page.locator(`[data-result-id="${result.id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"),
    `selected ${kind ?? "result"}`,
  );
  return result;
}

function exactHypotheses(graph) {
  return graph.tracking.hypotheses
    .filter((item) => item.kind === "split_or_merge")
    .map((item) => ({
      frame_id: item.frame_id,
      label: item.label,
      candidate_frame_id: item.candidate_frame_id,
      candidate_labels: item.candidate_labels,
      reason: item.reason,
    }));
}

let app;
let page;
const rendererMessages = [];
const reopenRendererMessages = [];
try {
  ({ app, page } = await launch(path.join(outputRoot, "user-data"), rendererMessages));
  await installDialogs(app, "initial");
  await openResearch(page);

  await createEmptyStudy(page);
  await visible(page, page.getByRole("main", { name: "Research workspace" }), "research workspace");
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const sourceButton = page
    .locator(".research-sources")
    .getByRole("button", { name: /^synthetic-split-merge\.ome\.tiff/ });
  await visible(page, sourceButton, "generated OME-TIFF source");
  const imported = await snapshot(page);
  assert.equal(imported.sources.length, 1);
  const source = imported.sources[0];
  assert.deepEqual(source.metadata.dimensions, { t: 3, c: 1, z: 1, y: 64, x: 64, s: 1 });
  assert.deepEqual(source.metadata.timing, {
    source: "ome-time-increment",
    timestamps: [],
    elapsed_times: [],
    frame_intervals: [],
    uniform_interval: 4,
    interval_unit: "s",
  });
  assert.equal(source.sha256, fixtureBefore.sha256);

  const frames = [];
  const frameRecords = [];
  const expectedCounts = [1, 2, 1];
  for (let timepoint = 0; timepoint < 3; timepoint += 1) {
    if (timepoint > 0) {
      await page.getByRole("button", { name: "Show source", exact: true }).click();
    }
    await selectWorkbenchTool(page, "Display");
    await page.getByLabel("T", { exact: true }).fill(String(timepoint));
    for (const [label, value] of [
      ["X", "0"],
      ["Y", "0"],
      ["Width", "64"],
      ["Height", "64"],
    ]) {
      await setSelectionField(page, label, value);
    }
    await selectWorkbenchTool(page, "Process");
    const preview = page.getByRole("button", { name: "Preview selected crop", exact: true });
    await preview.click();
    await waitFor(page, () => preview.isEnabled(), Boolean, `recipe preview for T=${timepoint}`);
    await noUiError(page, `recipe preview for T=${timepoint}`);
    await selectWorkbenchTool(page, "Analyze");
    await page.getByLabel("Threshold", { exact: true }).fill("500");
    const result = await newResult(
      page,
      () => page.getByRole("button", { name: "Run recipe", exact: true }).click(),
      "segmentation",
    );
    assert.equal(result.object_count, expectedCounts[timepoint]);
    assert.equal(result.source_id, source.id);
    assert.equal(result.source_sha256, source.sha256);
    assert.equal(result.selection.t, timepoint);
    const record = await page.evaluate(
      (resultId) => window.lociResearch.execute("result", { result_id: resultId }),
      result.id,
    );
    assert.equal(record.provenance.selection.t, timepoint);
    assert.equal(record.measurements.length, expectedCounts[timepoint]);
    frames.push(result);
    frameRecords.push(record);
  }
  await screenshot(page, "01-segmented-observed-frames");

  await selectWorkbenchTool(page, "Temporal");
  await visible(
    page,
    page.getByText(/Associations describe observations, not biological lineage or identity/),
    "non-biological interpretation",
  );
  for (const frame of frames) {
    const candidate = page
      .locator(".research-temporal .research-compact-list > div")
      .filter({ hasText: frame.id.slice(0, 8) });
    await candidate.getByRole("button", { name: "Add frame", exact: true }).click();
  }
  for (let index = 0; index < frames.length; index += 1) {
    assert.equal(
      await page.getByLabel(`Frame ${index + 1} elapsed seconds`).inputValue(),
      String(index * 4),
      "OME cadence must prefill actual elapsed seconds",
    );
  }
  assert.equal(await page.getByLabel("Confirm actual elapsed seconds").isChecked(), false);
  await page.getByLabel("Tracking maximum physical distance").fill("10");
  await page.getByLabel("Tracking maximum gap frames").fill("0");
  await page.getByLabel("Tracking ambiguity distance").fill("0.01");
  await page.getByLabel("Confirm actual elapsed seconds").check();
  await screenshot(page, "02-exact-tracking-input-preview");

  const tracked = await newResult(
    page,
    () => page.getByRole("button", { name: "Create temporal graph", exact: true }).click(),
    "temporal-tracking",
  );
  const graph = await trackingResult(page, tracked);
  assert.deepEqual(graph.tracking.frames.map((frame) => frame.frame_id), frames.map((item) => item.id));
  assert.deepEqual(graph.tracking.frames.map((frame) => frame.time_s), [0, 4, 8]);
  assert.deepEqual(graph.tracking.frames.map((frame) => frame.detections.length), expectedCounts);
  assert.equal(graph.tracking.edges.length, 2, "Candidate events must retain one-to-one edges");
  assert.deepEqual(exactHypotheses(graph), [
    {
      frame_id: frames[0].id,
      label: "1",
      candidate_frame_id: frames[1].id,
      candidate_labels: ["1", "2"],
      reason: "one source has multiple plausible targets",
    },
    {
      frame_id: frames[2].id,
      label: "1",
      candidate_frame_id: frames[1].id,
      candidate_labels: ["1", "2"],
      reason: "one target has multiple plausible sources",
    },
  ]);
  assert.deepEqual(
    graph.inputs.map((item) => ({
      result_id: item.result_id,
      revision_hash: item.revision_hash,
      source_id: item.source_id,
      source_sha256: item.source_sha256,
      time_s: item.time_s,
      t: item.selection.t,
    })),
    frames.map((item, index) => ({
      result_id: item.id,
      revision_hash: item.revision_hash,
      source_id: source.id,
      source_sha256: source.sha256,
      time_s: index * 4,
      t: index,
    })),
  );
  const hypothesisItems = page
    .getByRole("heading", { name: "Unresolved automatic hypotheses", exact: true })
    .locator("xpath=following-sibling::ul[1]/li");
  const visibleHypotheses = await hypothesisItems.allTextContents();
  assert.ok(visibleHypotheses.some((text) => text.includes("one source has multiple plausible targets")));
  assert.ok(visibleHypotheses.some((text) => text.includes("one target has multiple plausible sources")));
  assert.ok(visibleHypotheses.every((text) => text.includes("unresolved automatic hypothesis")));
  await hypothesisItems.first().scrollIntoViewIfNeeded();
  await visible(page, hypothesisItems.first(), "visible unresolved split/merge interpretation");
  await screenshot(page, "03-visible-split-merge-hypotheses");

  await page.getByLabel("Association to remove").selectOption("0");
  const corrected = await newResult(
    page,
    () => page.getByRole("button", { name: "Publish corrected graph revision", exact: true }).click(),
    "temporal-tracking",
  );
  assert.equal(corrected.parent_id, tracked.id);
  const correctedGraph = await trackingResult(page, corrected);
  assert.equal(correctedGraph.tracking.edges.length, 1);
  assert.deepEqual(exactHypotheses(correctedGraph), exactHypotheses(graph));
  assert.deepEqual(correctedGraph.inputs, graph.inputs);
  await screenshot(page, "04-corrected-association-revision");

  await selectWorkbenchTool(page, "Info");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const reviewed = await waitFor(
    page,
    () => snapshot(page),
    (state) =>
      state.results.find((item) => item.id === corrected.id)?.review?.disposition === "reviewed",
    "human review of corrected temporal revision",
  );
  const reviewedResult = reviewed.results.find((item) => item.id === corrected.id);
  await page.getByRole("button", { name: "Export revision", exact: true }).click();
  await waitFor(
    page,
    () => fs.readdir(exportPath).catch(() => []),
    (names) => ["manifest.json", "result.json", "tracking.json", "trajectories.csv"].every((name) => names.includes(name)),
    "atomic reviewed temporal export",
  );
  const [exportManifest, exportReceipt, exportedTracking] = await Promise.all([
    fs.readFile(path.join(exportPath, "manifest.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(exportPath, "result.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(exportPath, "tracking.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(exportManifest.result_id, corrected.id);
  assert.equal(exportManifest.revision_hash, corrected.revision_hash);
  assert.equal(exportReceipt.review.disposition, "reviewed");
  assert.equal(exportReceipt.source.id, source.id);
  assert.equal(exportReceipt.source.sha256, source.sha256);
  assert.deepEqual(exportReceipt.source.metadata.timing, source.metadata.timing);
  assert.equal(
    exportReceipt.result.provenance.scientific_interpretation,
    "observed-associations; no asserted lineage or biological identity",
  );
  assert.deepEqual(canonical(exportedTracking.tracking), canonical(correctedGraph.tracking));
  assert.deepEqual(canonical(exportedTracking.inputs), canonical(correctedGraph.inputs));
  await screenshot(page, "05-reviewed-temporal-export");

  const initialDialogs = await app.evaluate(() => globalThis.__lociTemporalQaDialogs);
  assert.deepEqual(initialDialogs.filter((item) => item.kind !== "message"), [
    { kind: "save", title: "Create research study" },
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "save", title: "Export reviewed result bundle" },
  ]);
  await close(app);
  app = undefined;
  page = undefined;

  ({ app, page } = await launch(path.join(outputRoot, "reopen-user-data"), reopenRendererMessages));
  await installDialogs(app, "reopen");
  await openResearch(page);
  await visible(page, page.getByRole("button", { name: "Open study", exact: true }), "fresh-profile open study");
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await visible(page, page.getByRole("main", { name: "Research workspace" }), "reopened research workspace");
  const reopened = await snapshot(page);
  const reopenedSource = reopened.sources.find((item) => item.id === source.id);
  const reopenedResult = reopened.results.find((item) => item.id === corrected.id);
  assert.ok(reopenedSource, "Exact source identity was lost on reopen");
  assert.ok(reopenedResult, "Reviewed temporal revision was lost on reopen");
  assert.equal(reopenedSource.sha256, source.sha256);
  assert.deepEqual(reopenedSource.metadata.timing, source.metadata.timing);
  assert.equal(reopenedResult.revision_hash, corrected.revision_hash);
  assert.equal(reopenedResult.review.disposition, "reviewed");
  const reopenedGraph = await trackingResult(page, reopenedResult);
  assert.deepEqual(canonical(reopenedGraph.tracking), canonical(correctedGraph.tracking));
  assert.deepEqual(canonical(reopenedGraph.inputs), canonical(correctedGraph.inputs));
  await selectWorkbenchTool(page, "Temporal");
  await page.getByLabel("Tracking result revision").selectOption(corrected.id);
  await page.getByRole("button", { name: "Inspect graph", exact: true }).click();
  await visible(page, page.getByRole("heading", { name: "Observed associations", exact: true }), "reopened graph inspection");
  await visible(
    page,
    page.getByText(/Associations describe observations, not biological lineage or identity/),
    "reopened non-biological interpretation",
  );
  const reopenedHypotheses = page
    .getByRole("heading", { name: "Unresolved automatic hypotheses", exact: true })
    .locator("xpath=following-sibling::ul[1]/li");
  await reopenedHypotheses.first().scrollIntoViewIfNeeded();
  await visible(page, reopenedHypotheses.first(), "reopened unresolved split/merge interpretation");
  await screenshot(page, "06-reopened-exact-temporal-graph");
  const reopenDialogs = await app.evaluate(() => globalThis.__lociTemporalQaDialogs);
  assert.deepEqual(reopenDialogs.filter((item) => item.kind !== "message"), [
    { kind: "open", title: "Open research study" },
  ]);

  const [buildAfter, fixtureAfter, exportFiles] = await Promise.all([
    buildIdentity(),
    fileIdentity(fixturePath),
    fs.readdir(exportPath).then((names) => names.sort()),
  ]);
  assert.deepEqual(buildAfter, buildBefore, "Packaged application changed during QA");
  assert.deepEqual(fixtureAfter, fixtureBefore, "Generated OME-TIFF source changed during QA");
  assert.deepEqual(
    rendererMessages.filter((item) => item.type !== "warning"),
    [],
    "Initial renderer emitted errors",
  );
  assert.deepEqual(
    reopenRendererMessages.filter((item) => item.type !== "warning"),
    [],
    "Reopened renderer emitted errors",
  );
  const report = {
    schema: "loci.temporal-split-merge-packaged-qa/v1",
    status: "passed",
    started_at: startedAt,
    elapsed_seconds: (performance.now() - startedClock) / 1000,
    app_bundle: appBundle,
    build: buildBefore,
    source_tree: sourceTree,
    fixture: { path: fixturePath, ...fixtureBefore },
    source: {
      id: source.id,
      sha256: source.sha256,
      timing: source.metadata.timing,
      dimensions: source.metadata.dimensions,
    },
    frame_results: frames.map((item, index) => ({
      id: item.id,
      revision_hash: item.revision_hash,
      t: index,
      time_s: index * 4,
      object_count: item.object_count,
      source_id: item.source_id,
      source_sha256: item.source_sha256,
      measurements: frameRecords[index].measurements,
    })),
    automatic_graph: {
      id: tracked.id,
      revision_hash: tracked.revision_hash,
      edge_count: graph.tracking.edges.length,
      split_merge_hypotheses: exactHypotheses(graph),
      visible_hypotheses: visibleHypotheses,
    },
    corrected_reviewed_graph: {
      id: corrected.id,
      revision_hash: corrected.revision_hash,
      parent_id: corrected.parent_id,
      edge_count: correctedGraph.tracking.edges.length,
      reviewed: reviewedResult.review,
      export_manifest: exportManifest,
      export_files: exportFiles,
      export_reopened_exactly: true,
    },
    renderer_messages: { initial: rendererMessages, reopen: reopenRendererMessages },
    screenshots: await fs.readdir(screenshotsPath).then((names) => names.sort()),
    hardware: {
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  if (page) {
    await screenshot(page, "failure").catch(() => undefined);
  }
  await fs.writeFile(
    failurePath,
    JSON.stringify(
      {
        schema: "loci.temporal-split-merge-packaged-qa-failure/v1",
        status: "failed",
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        renderer_messages: { initial: rendererMessages, reopen: reopenRendererMessages },
        body: page ? await page.locator("body").innerText().catch(() => null) : null,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
}
