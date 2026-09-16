import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const harnessPath = path.resolve(import.meta.filename);
if (process.platform !== "darwin")
  throw new Error("Whole-slide packaged QA currently requires macOS.");

const appBundle = path.resolve(
  process.env.LOCI_PACKAGED_APP ??
    path.join(
      desktopRoot, "..", ".loci", "builds", "current", "Loci.app",
    ),
);
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const resourcesPath = path.join(appBundle, "Contents", "Resources");
const workerPath = path.join(resourcesPath, "loci-engine", "loci-engine");
const asarPath = path.join(resourcesPath, "app.asar");
const fixtureRoot = path.resolve(
  process.env.LOCI_QA_WSI_FIXTURES ?? "/tmp/loci-release-run/wsi",
);
const fixture = {
  svs: {
    file: path.join(fixtureRoot, "CMU-1-Small-Region.svs"),
    size: 1_938_955,
    sha256: "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7",
    levels: [[2220, 2967, 1]],
  },
  ndpi: {
    file: path.join(fixtureRoot, "CMU-1.ndpi"),
    size: 198_030_965,
    sha256: "edf4a1ccf395c7000ae93ad3b44c07d97043810e00be0c1d167dd09bbe436e46",
    levels: [
      [51200, 38144, 1],
      [25600, 19072, 2],
      [12800, 9536, 4],
      [6400, 4768, 8],
      [3200, 2384, 16],
      [1600, 1192, 32],
      [800, 596, 64],
      [400, 298, 128],
      [200, 149, 256],
    ],
  },
};

const runName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(projectRoot, ".loci", "qa"),
  "whole-slide-" + runName,
);
const userData = path.join(runRoot, "user-data");
const studyPath = path.join(runRoot, "study", "public-wsi.loci-study");
const outputPath = path.join(runRoot, "output");
const screenshotsPath = path.join(outputPath, "screenshots");
const roiExportPath = path.join(outputPath, "reviewed-wsi-roi");
const stainExportPaths = ["svs", "ndpi"].map((kind) => path.join(outputPath, `reviewed-${kind}-stain`));
await Promise.all([
  fs.mkdir(userData, { recursive: true }),
  fs.mkdir(path.dirname(studyPath), { recursive: true }),
  fs.mkdir(screenshotsPath, { recursive: true }),
  fs.access(executablePath, fs.constants.X_OK),
  fs.access(workerPath, fs.constants.X_OK),
  ...Object.values(fixture).map(({ file }) => fs.access(file)),
]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function identity(file) {
  const stat = await fs.stat(file);
  assert.ok(stat.isFile(), "Expected a regular file: " + file);
  return { size_bytes: stat.size, sha256: await sha256(file) };
}

function makeRssSampler(rootPid) {
  let busy = false;
  let timer;
  let pending = Promise.resolve();
  const samples = [];
  let peakTree = 0;
  let peakWorker = 0;

  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="], {
        timeout: 5_000,
      });
      const rows = stdout.split("\n").map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return match
          ? { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }
          : null;
      }).filter(Boolean);
      const descendants = new Set([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
            descendants.add(row.pid);
            changed = true;
          }
        }
      }
      const tree = rows.filter((row) => descendants.has(row.pid));
      const treeRss = tree.reduce((sum, row) => sum + row.rssKiB * 1024, 0);
      const workerRss = tree
        .filter((row) => /(?:^|\/)loci-engine(?:\s|$)/.test(row.command))
        .reduce((sum, row) => sum + row.rssKiB * 1024, 0);
      peakTree = Math.max(peakTree, treeRss);
      peakWorker = Math.max(peakWorker, workerRss);
      samples.push({ at_ms: Date.now(), tree_rss_bytes: treeRss, worker_rss_bytes: workerRss });
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      pending = sample();
      timer = setInterval(() => {
        if (!busy) pending = sample();
      }, 100);
    },
    async checkpoint() {
      await sample();
      return samples.at(-1) ?? { at_ms: Date.now(), tree_rss_bytes: 0, worker_rss_bytes: 0 };
    },
    async stop() {
      clearInterval(timer);
      await pending;
      await sample();
      return {
        interval_ms: 100,
        sample_count: samples.length,
        peak_tree_rss_bytes: peakTree,
        peak_worker_rss_bytes: peakWorker,
        final: samples.at(-1),
      };
    },
  };
}

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(action + ": " + ((await alert.textContent()) ?? "unknown UI error"));
}

async function visible(page, locator, label, timeout = 120_000) {
  await locator.waitFor({ state: "visible", timeout });
  await noUiError(page, "waiting for " + label);
  return locator;
}

async function waitForValue(read, accept, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + label);
}

const snapshot = (page) => page.evaluate(() => window.lociResearch.getSnapshot());
const inspectResult = (page, id) => page.evaluate(
  (result_id) => window.lociResearch.execute("result", { result_id }),
  id,
);

async function verifyExportManifest(destination, result) {
  const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, "loci.export-manifest/v1");
  assert.equal(manifest.result_id, result.id);
  assert.equal(manifest.revision_hash, result.revision_hash);
  const names = manifest.files.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual((await fs.readdir(destination)).sort(), [...names, "manifest.json"].sort());
  for (const entry of manifest.files) {
    assert.equal(path.basename(entry.name), entry.name);
    assert.deepEqual(await identity(path.join(destination, entry.name)), {
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
    });
  }
  return manifest.files.length;
}

async function waitSelectedResult(page, id, label) {
  await waitForValue(
    () => page.locator(`[data-result-id="${id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"),
    label,
  );
}

async function viewerState(page, sourceName) {
  return page.evaluate((name) => {
    const viewer = [...document.querySelectorAll(".image-viewport")].find(
      (item) => item.getAttribute("aria-label") === `Image viewer: ${name}`,
    );
    let camera = null;
    try { camera = JSON.parse(viewer?.getAttribute("data-camera") ?? "null"); }
    catch { camera = null; }
    return {
      present: Boolean(viewer),
      camera,
      level: Number(viewer?.getAttribute("data-auto-level")),
      cacheBytes: Number(viewer?.getAttribute("data-cache-bytes")),
      loading: Boolean(viewer?.querySelector(".image-view-loading")),
      resultOverlay: viewer?.getAttribute("data-result-overlay") ?? null,
      alert: document.querySelector(".research-alert[role=alert]")?.textContent ?? null,
    };
  }, sourceName);
}

async function waitViewport(page, sourceName, action, accept = () => true, timeout = 120_000) {
  await waitForValue(
    () => viewerState(page, sourceName),
    (state) => {
      if (state.alert) throw new Error(action + ": " + state.alert);
      return state.present && state.cacheBytes > 0 && !state.loading && state.camera && accept(state);
    },
    action,
    timeout,
  );
  await noUiError(page, action);
  return viewerState(page, sourceName);
}

async function screenshot(page, name) {
  const file = path.join(screenshotsPath, name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  return path.basename(file);
}

async function installDialogs(app) {
  await app.evaluate(
    ({ dialog }, values) => {
      globalThis.__lociWholeSlideQaDialogs = [];
      globalThis.__lociWholeSlideExportIndex = 0;
      dialog.showOpenDialog = async (...args) => {
        const title = args.at(-1)?.title;
        globalThis.__lociWholeSlideQaDialogs.push({ kind: "open", title });
        if (title === "Add microscopy or medical images")
          return { canceled: false, filePaths: values.sources };
        if (title === "Open research study")
          return { canceled: false, filePaths: [values.study] };
        throw new Error("Unexpected native open dialog: " + String(title));
      };
      dialog.showSaveDialog = async (...args) => {
        const title = args.at(-1)?.title;
        globalThis.__lociWholeSlideQaDialogs.push({ kind: "save", title });
        if (title === "Save research study as")
          return { canceled: false, filePath: values.study };
        if (title === "Export reviewed result bundle") {
          const destination = values.exports[globalThis.__lociWholeSlideExportIndex++];
          if (!destination) throw new Error("Unexpected additional WSI export");
          return { canceled: false, filePath: destination };
        }
        throw new Error("Unexpected native save dialog: " + String(title));
      };
      dialog.showMessageBox = async (...args) => {
        const title = args.at(-1)?.title;
        globalThis.__lociWholeSlideQaDialogs.push({ kind: "message", title });
        throw new Error("Unexpected native message dialog: " + String(title));
      };
    },
    {
      sources: [fixture.svs.file, fixture.ndpi.file],
      study: studyPath,
      exports: [roiExportPath, ...stainExportPaths],
    },
  );
}

async function dialogTrace(app) {
  return app.evaluate(() => globalThis.__lociWholeSlideQaDialogs ?? []);
}

async function selectedSource(page, fileName) {
  await page
    .locator(".research-sources")
    .getByRole("button", { name: new RegExp("^" + fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .click();
  await page.waitForFunction(
    (name) => [...document.querySelectorAll(".research-sources button")]
      .some((button) => button.textContent?.startsWith(name) && button.classList.contains("selected")),
    fileName,
  );
  await noUiError(page, "selecting " + fileName);
  return waitViewport(page, fileName, "loading the full-source viewer for " + fileName);
}

async function selectTool(page, group, value) {
  await selectWorkbenchTool(page, value);
}

async function selectAdvancedTool(page, query, label) {
  await page.getByRole("button", { name: "Search all tools" }).click();
  await page.getByLabel("Search all tools").fill(query);
  await page.getByRole("list", { name: "All tools" }).getByRole("button", { name: label, exact: true }).click();
}

async function setSelection(page, sourceName, expected) {
  await selectTool(page, "View", "Display");
  const details = page.locator("details.analysis-region-settings");
  if (!await details.evaluate((element) => element.open))
    await details.getByText("Analysis region", { exact: true }).click();
  const cameraBefore = (await viewerState(page, sourceName)).camera;
  for (const [label, key] of [["X", "x"], ["Y", "y"], ["Width", "width"], ["Height", "height"]])
    await page.getByLabel(label, { exact: true }).fill(String(expected[key]));
  for (const [label, key] of [["X", "x"], ["Y", "y"], ["Width", "width"], ["Height", "height"]])
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), String(expected[key]));
  const state = await waitViewport(page, sourceName, "retaining the full-source viewer after setting analysis scope");
  assert.deepEqual(state.camera, cameraBefore,
    "Changing the analysis scope unexpectedly changed the source camera.");
  return { selection: expected, viewer: state };
}

async function moveCamera(page, sourceName, action, operate, accept) {
  const before = await viewerState(page, sourceName);
  await operate(page.getByLabel(`Image viewer: ${sourceName}`));
  const after = await waitViewport(page, sourceName, action, (state) => accept(state, before));
  return { before: before.camera, after: after.camera, level: after.level };
}

async function centerViewerOnSelection(page, source, selection) {
  const viewer = page.getByLabel(`Image viewer: ${source.name}`);
  const navigator = viewer.getByRole("button", { name: "Overview navigator" });
  const bounds = await navigator.boundingBox();
  assert.ok(bounds, "The whole-slide overview navigator is unavailable.");
  const x = selection.x + selection.width / 2;
  const y = selection.y + selection.height / 2;
  await navigator.click({ position: {
    x: Math.max(1, Math.min(bounds.width - 1, x / source.metadata.dimensions.x * bounds.width)),
    y: Math.max(1, Math.min(bounds.height - 1, y / source.metadata.dimensions.y * bounds.height)),
  } });
  await viewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  return waitViewport(page, source.name, "centering the shared camera on the exact result crop", (state) =>
    Math.abs(state.camera.x - x) < Math.max(2, source.metadata.dimensions.x * 0.01) &&
    Math.abs(state.camera.y - y) < Math.max(2, source.metadata.dimensions.y * 0.01) && state.level === 0);
}

async function clickSourcePoints(page, source, points) {
  const viewer = page.getByLabel(`Image viewer: ${source.name}`);
  const canvas = viewer.getByLabel("Source image and bound annotations");
  const bounds = await canvas.boundingBox();
  const state = await viewerState(page, source.name);
  assert.ok(bounds && state.camera, "The shared source camera is unavailable for correction.");
  const spacing = source.metadata.physical_calibration?.spacing;
  const aspectY = spacing?.length >= 2 && spacing.at(-1) > 0
    ? spacing.at(-2) / spacing.at(-1) : 1;
  for (const point of points) {
    const screenX = bounds.x + bounds.width / 2 + (point.x - state.camera.x) * state.camera.scale;
    const screenY = bounds.y + bounds.height / 2 +
      (point.y - state.camera.y) * state.camera.scale * aspectY;
    assert.ok(screenX >= bounds.x && screenX < bounds.x + bounds.width &&
      screenY >= bounds.y && screenY < bounds.y + bounds.height,
    "A correction point is outside the visible shared source camera.");
    await page.mouse.click(screenX, screenY);
  }
}

async function sourceRecord(page, fileName) {
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const source = snapshot.sources.find((item) => item.name === fileName);
  assert.ok(source, "Imported source is absent: " + fileName);
  return source;
}

async function qualifyStainRule(page, report, sourceFixture, selection, destination,
  expectedCount, expectedAccepted) {
  await setSelection(page, path.basename(sourceFixture.file), selection);
  await selectTool(page, "Analyze", "Analyze");
  await page.getByLabel("Segmentation model").selectOption("stain");
  await page.getByLabel("Stain basis").selectOption("H&E");
  await page.getByLabel("Stain component").selectOption("0");
  await page.getByLabel("Stain-coordinate threshold").fill("0.15");
  await page.getByLabel("Stain minimum object size").fill("10");
  await page.getByLabel("Stain segmentation method").selectOption("components");
  assert.match(
    await page.getByLabel("Stain minimum object size").locator("..").innerText(),
    /(?:um|µm)²/,
    "The area threshold must display the calibrated source unit, not pixels",
  );
  const rule = {
    name: "Declared technical hematoxylin rule",
    channel: "hematoxylin-basis",
    statistic: "mean",
    threshold: 0.2,
    control: "Public CC0 slide; fixed stain-coordinate rule for technical reproducibility only, without biological classification.",
  };
  await page.getByLabel("Enable stain measurement rule").check();
  await page.getByLabel("Stain rule name").fill(rule.name);
  await page.getByLabel("Stain rule channel").selectOption("0");
  await page.getByLabel("Stain rule statistic").selectOption(rule.statistic);
  await page.getByLabel("Stain rule threshold").fill(String(rule.threshold));
  await page.getByLabel("Stain rule control or evidence").fill(rule.control);
  await page.getByRole("button", { name: "Preview declared stain", exact: true }).click();
  await waitForValue(
    () => page.getByRole("button", { name: "Run declared stain", exact: true }).isEnabled(),
    Boolean,
    "the completed declared-stain preview",
  );
  await noUiError(page, "previewing the declared stain rule");
  const previous = new Set((await snapshot(page)).results.map((item) => item.id));
  await page.getByRole("button", { name: "Run declared stain", exact: true }).click();
  const completed = await waitForValue(
    () => snapshot(page),
    (state) => state.results.some((item) => !previous.has(item.id) && item.kind === "declared-stain-analysis"),
    "the durable stain-rule result",
  );
  const result = completed.results.find((item) => !previous.has(item.id) && item.kind === "declared-stain-analysis");
  await waitSelectedResult(page, result.id, "the selected stain-rule result");
  const inspected = await inspectResult(page, result.id);
  assert.equal(inspected.provenance.stain_separation.declared_basis, "H&E");
  assert.equal(inspected.provenance.stain_separation.input, "source-device-RGB; display ICC transform excluded");
  assert.deepEqual(inspected.provenance.recipe.gates, [rule]);
  assert.deepEqual(inspected.provenance.selection, { ...selection, t: 0, c: 0, z: 0 });
  assert.equal(inspected.provenance.segmentation.size_unit, "um^2");
  assert.equal(inspected.provenance.segmentation.min_size, 10);
  assert.equal(inspected.measurements.length, expectedCount);
  for (const row of inspected.measurements) {
    assert.equal(row.marker_gates[rule.name], row.intensity[rule.channel].mean > rule.threshold);
    assert.equal(row.measure_unit, "um^2");
  }
  const accepted = inspected.measurements.filter((row) => row.marker_gates[rule.name]).length;
  assert.equal(accepted, expectedAccepted,
    "The fixed public control changed its declared-rule positive count");
  await waitForValue(
    () => page.locator(".research-result-table tbody tr").count(),
    (count) => count === expectedCount,
    "the inspectable stain-rule object table",
  );
  report.screenshots.push(await screenshot(page, `${path.basename(sourceFixture.file)}-stain-rule`));
  await selectTool(page, "Results", "Info");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await waitForValue(
    () => snapshot(page),
    (state) => state.results.find((item) => item.id === result.id)?.review?.disposition === "reviewed",
    "the reviewed exact stain-rule revision",
  );
  await page.getByRole("button", { name: "Export revision", exact: true }).click();
  await waitForValue(
    () => fs.readdir(destination).catch(() => []),
    (files) => ["labels.npy", "image.npy", "labels.ome.tif", "result.json", "objects.csv", "manifest.json"].every((name) => files.includes(name)),
    "the atomic stain-rule export",
  );
  const exported = JSON.parse(await fs.readFile(path.join(destination, "result.json"), "utf8"));
  assert.equal(exported.result.id, result.id);
  assert.equal(exported.result.revision_hash, result.revision_hash);
  assert.equal(exported.review.disposition, "reviewed");
  const manifestFilesVerified = await verifyExportManifest(destination, result);
  // Direct reader, low-level stain transform and connected components are an
  // independent reference for the GUI's full operation chain. Settings and
  // numeric tolerances were fixed before qualification; these are not labels
  // of biological truth.
  const reference = JSON.parse((await run(path.join(projectRoot, "engine/.venv/bin/python"), ["-c", `
import hashlib,json,sys
from pathlib import Path
import numpy as np, openslide, tifffile
from scipy import ndimage
from skimage.color import separate_stains,hed_from_rgb
source=Path(sys.argv[1]); out=Path(sys.argv[2]); x,y=map(int,sys.argv[3:5])
with openslide.OpenSlide(str(source)) as slide:
    rgb=np.asarray(slide.read_region((x,y),0,(128,128)).convert('RGB'))
    sx=float(slide.properties['openslide.mpp-x']); sy=float(slide.properties['openslide.mpp-y'])
stain=separate_stains(rgb,hed_from_rgb)[...,0]
labels,_=ndimage.label(stain>0.15,structure=ndimage.generate_binary_structure(2,1))
ids,counts=np.unique(labels,return_counts=True)
labels[np.isin(labels,ids[counts*sx*sy<10])]=0
positive=np.unique(labels); positive=positive[positive!=0]
compact=np.searchsorted(positive,labels).astype(np.uint32)+1; compact[labels==0]=0
np.testing.assert_array_equal(np.load(out/'labels.npy',allow_pickle=False),compact)
np.testing.assert_array_equal(tifffile.imread(out/'labels.ome.tif'),compact)
np.testing.assert_allclose(np.load(out/'image.npy',allow_pickle=False),stain,rtol=0,atol=1e-12)
print(json.dumps({'objects':len(positive),'positive_rules':sum(float(stain[compact==i].mean())>0.2 for i in range(1,len(positive)+1)),'label_sha256':hashlib.sha256(compact.tobytes()).hexdigest(),'array_equality':True,'stain_atol':1e-12,'area_unit':'um^2'}))
`, sourceFixture.file, destination, String(selection.x), String(selection.y)], { timeout: 60_000 })).stdout);
  assert.equal(reference.objects, expectedCount);
  assert.equal(reference.positive_rules, accepted);
  await selectAdvancedTool(page, "Import & share", "Import & share results");
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await waitForValue(
    () => snapshot(page),
    (state) => state.results.find((item) => item.id === result.id)?.revision_hash === result.revision_hash,
    "reopen of the exact classified revision",
  );
  const reopened = await inspectResult(page, result.id);
  assert.deepEqual(reopened.measurements, inspected.measurements);
  assert.deepEqual(reopened.provenance, inspected.provenance);
  assert.equal(reopened.result.review.disposition, "reviewed");
  await selectedSource(page, path.basename(sourceFixture.file));
  await waitForValue(() => page.locator(`[data-result-id="${result.id}"]`).isEnabled(), Boolean, "the reopened classified result control");
  await page.locator(`[data-result-id="${result.id}"]`).click();
  await waitSelectedResult(page, result.id, "the reopened classified result");
  await selectTool(page, "Analyze", "Analyze");
  await waitForValue(() => page.locator(".research-result-table tbody tr").count(), (count) => count === expectedCount, "the reopened classification table");
  report.screenshots.push(await screenshot(page, `${path.basename(sourceFixture.file)}-stain-rule-reopened`));
  report.stain_rule_roundtrip = { result_id: result.id, revision_hash: result.revision_hash,
    selection: inspected.provenance.selection, object_count: expectedCount,
    declared_rule_positive_count: expectedAccepted, rule, reference,
    manifest_files_verified: manifestFilesVerified, exported_review_reopened_exactly: true };
  await page.getByRole("button", { name: "Show source", exact: true }).click();
}

function validatedLevels(source, expected) {
  const display = source.metadata.levels;
  const wholeSlide = source.metadata.whole_slide;
  assert.ok(Array.isArray(display), "Display-level metadata is absent");
  assert.ok(Array.isArray(wholeSlide?.levels), "Whole-slide downsample metadata is absent");
  assert.equal(display.length, expected.length);
  assert.equal(wholeSlide.levels.length, expected.length);
  return expected.map(([x, y, downsample], index) => {
    assert.equal(display[index].index, index);
    assert.equal(display[index].dimensions.x, x);
    assert.equal(display[index].dimensions.y, y);
    assert.equal(wholeSlide.levels[index].index, index);
    assert.deepEqual(wholeSlide.levels[index].dimensions_xy, [x, y]);
    assert.equal(wholeSlide.levels[index].downsample, downsample);
    return { index, dimensions: { x, y }, downsample };
  });
}

async function timed(report, rss, name, action) {
  const started = performance.now();
  const scope = await action();
  const memory = await rss.checkpoint();
  report.steps.push({ name, duration_ms: Number((performance.now() - started).toFixed(3)), scope, memory });
}

const expectedBefore = {};
for (const [key, value] of Object.entries(fixture)) {
  expectedBefore[key] = await identity(value.file);
  assert.equal(expectedBefore[key].size_bytes, value.size);
  assert.equal(expectedBefore[key].sha256, value.sha256);
}

const app = await electron.launch({
  executablePath,
  args: ["--user-data-dir=" + userData],
  cwd: desktopRoot,
  timeout: 120_000,
});
const page = await app.firstWindow();
const rss = makeRssSampler(app.process().pid);
rss.start();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

const sourceReports = [];
let memory;
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await visible(page, page.getByRole("main", { name: "Loci workspace" }), "image-first welcome");
  await installDialogs(app);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await visible(page, page.getByRole("main", { name: "Research workspace" }), "research workspace");
  await visible(
    page,
    page.locator(".research-sources").getByRole("button", { name: /^CMU-1\.ndpi/ }),
    "both imported whole-slide sources",
    180_000,
  );
  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await waitForValue(
    () => fs.access(path.join(studyPath, "study.sqlite3")).then(() => true).catch(() => false),
    Boolean,
    "the explicit whole-slide study copy",
  );
  assert.deepEqual(await dialogTrace(app), [
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "save", title: "Save research study as" },
  ]);

  const svsReport = { file: path.basename(fixture.svs.file), steps: [] };
  sourceReports.push(svsReport);
  const svsFullFit = await selectedSource(page, svsReport.file);
  const svsSource = await sourceRecord(page, svsReport.file);
  assert.equal(svsSource.sha256, fixture.svs.sha256);
  const svsLevels = validatedLevels(svsSource, fixture.svs.levels);
  svsReport.levels = svsLevels;
  svsReport.coarse_level_available = false;
  assert.equal(svsFullFit.level, 0, "The single-level SVS must render at its only native level.");
  svsReport.full_source_camera = svsFullFit;
  let selection = { level: 0, x: 640, y: 512, width: 256, height: 256 };
  await timed(svsReport, rss, "set-bounded-analysis-scope-without-moving-camera", () =>
    setSelection(page, svsReport.file, selection));
  svsReport.screenshots = [await screenshot(page, "svs-full-source-with-analysis-scope")];
  await timed(svsReport, rss, "source-camera-pan-right", () =>
    moveCamera(page, svsReport.file, "SVS source-camera pan right",
      (viewer) => viewer.press("ArrowRight"),
      (state, before) => state.camera.x > before.camera.x));
  await timed(svsReport, rss, "source-camera-pan-down-one-native-pixel", () =>
    moveCamera(page, svsReport.file, "SVS one-pixel source-camera pan",
      (viewer) => viewer.press("Shift+ArrowDown"),
      (state, before) => Math.abs(state.camera.y - before.camera.y - 1) < 1e-6));
  await timed(svsReport, rss, "source-camera-zoom-in", () =>
    moveCamera(page, svsReport.file, "SVS source-camera zoom in",
      (viewer) => viewer.locator(".image-view-tools").getByRole("button", { name: "Zoom in" }).click(),
      (state, before) => state.camera.scale > before.camera.scale));
  svsReport.screenshots.push(await screenshot(page, "svs-source-camera-panned-zoomed"));

  const tissueSelection = { level: 0, x: 1227, y: 763, width: 128, height: 128 };
  await timed(svsReport, rss, "set-technical-control-analysis-scope", () =>
    setSelection(page, svsReport.file, tissueSelection));
  await selectTool(page, "Analyze", "Analyze");
  await page.getByLabel("Segmentation model").selectOption("stain");
  await page.getByLabel("Tissue closing radius").fill("2");
  await page.getByLabel("Tissue minimum region").fill("16");
  const tissueControl = "Public CC0 slide, bounded 128 x 128 technical UI control; visual review only.";
  await page.getByLabel("Tissue control or review criterion").fill(tissueControl);
  await timed(svsReport, rss, "preview-declared-tissue-mask", async () => {
    await page.getByRole("button", { name: "Preview tissue mask", exact: true }).click();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) => item.textContent === "Adopt tissue mask");
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 120_000 });
    await noUiError(page, "previewing the declared tissue mask");
    return tissueSelection;
  });
  svsReport.screenshots.push(await screenshot(page, "svs-tissue-preview"));
  const beforeAdopt = await page.evaluate(() => window.lociResearch.getSnapshot());
  const priorIds = beforeAdopt.results.map((item) => item.id);
  let adoptedSnapshot;
  await timed(svsReport, rss, "adopt-declared-tissue-mask", async () => {
    await page.getByRole("button", { name: "Adopt tissue mask", exact: true }).click();
    adoptedSnapshot = await waitForValue(
      () => page.evaluate(() => window.lociResearch.getSnapshot()),
      (snapshot) => snapshot.results.some(
        (item) => !priorIds.includes(item.id) && item.kind === "tissue-region-mask",
      ),
      "the adopted tissue result",
    );
    await noUiError(page, "adopting the declared tissue mask");
    return tissueSelection;
  });
  const adopted = adoptedSnapshot.results
    .find((item) => !priorIds.includes(item.id) && item.kind === "tissue-region-mask");
  assert.ok(adopted, "The adopted tissue result is absent from immutable history");
  const tissueRecord = await page.evaluate(
    (resultId) => window.lociResearch.execute("result", { result_id: resultId }),
    adopted.id,
  );
  assert.deepEqual(tissueRecord.provenance.selection, { ...tissueSelection, t: 0, c: 0, z: 0 });
  assert.equal(tissueRecord.provenance.tissue_mask.control, tissueControl);
  assert.equal(tissueRecord.provenance.tissue_mask.scope, "selected bounded native region only");
  assert.equal(tissueRecord.provenance.tissue_mask.scientific_validation, "unvalidated-research-method");
  svsReport.technical_control = {
    selection: tissueRecord.provenance.selection,
    result_kind: adopted.kind,
    result_revision: adopted.revision_hash,
    object_count: adopted.object_count,
    control: tissueControl,
    validation_scope: tissueRecord.provenance.tissue_mask.scientific_validation,
  };
  svsReport.screenshots.push(await screenshot(page, "svs-tissue-adopted"));

  await selectTool(page, "Annotate", "Correction");
  await page.getByText(/Loading exact correction plane/).waitFor({ state: "hidden" }).catch(() => undefined);
  await page.getByLabel("Correction tool").selectOption("roi");
  await page.getByLabel("ROI ID").fill("wsi-qa-roi");
  await waitViewport(page, svsReport.file, "the exact tissue result on the shared source camera",
    (state) => state.resultOverlay === `${adopted.id}:${adopted.revision_hash}`);
  await centerViewerOnSelection(page, svsSource, tissueSelection);
  const roiUv = [[25, 25], [83, 32], [58, 90]];
  await clickSourcePoints(page, svsSource, roiUv.map(([u, v]) => ({
    x: tissueSelection.x + u + 0.5,
    y: tissueSelection.y + v + 0.5,
  })));
  await waitForValue(
    () => page.getByRole("button", { name: "Add measured ROI", exact: true }).isEnabled(),
    Boolean,
    "the source-camera ROI correction preview",
  );
  svsReport.screenshots.push(await screenshot(page, "svs-shared-camera-roi-preview"));
  const beforeRoi = new Set((await snapshot(page)).results.map((item) => item.id));
  await page.getByRole("button", { name: "Add measured ROI", exact: true }).click();
  const roiSnapshot = await waitForValue(
    () => snapshot(page),
    (state) => state.results.some(
      (item) => !beforeRoi.has(item.id) && item.kind === "annotated-result",
    ),
    "the immutable WSI ROI result",
  );
  const roiResult = roiSnapshot.results.find(
    (item) => !beforeRoi.has(item.id) && item.kind === "annotated-result",
  );
  assert.ok(roiResult, "The immutable WSI ROI result is absent");
  await waitSelectedResult(page, roiResult.id, "open the immutable WSI ROI result");
  const roiRecord = await inspectResult(page, roiResult.id);
  assert.equal(roiResult.parent_id, adopted.id);
  assert.deepEqual(roiRecord.provenance.selection, tissueRecord.provenance.selection);
  const annotation = roiRecord.provenance.annotations.find(
    (item) => item.id === "wsi-qa-roi",
  );
  assert.ok(annotation, "The WSI ROI annotation is absent from exact provenance");
  const properties = annotation.geojson.properties;
  assert.equal(properties.result_sha256, adopted.revision_hash);
  assert.equal(properties.source_sha256, fixture.svs.sha256);
  assert.equal(properties.distance_unit, "um");
  assert.equal(properties.plane, "XY");
  assert.deepEqual(properties.image_shape, [tissueSelection.height, tissueSelection.width]);
  assert.deepEqual(properties.polygon_uv, roiUv,
    "The shared source camera changed the intended result-grid ROI vertices.");
  const affine = properties.affine_xyz_to_world;
  for (let index = 0; index < properties.polygon_uv.length; index++) {
    const [u, v] = properties.polygon_uv[index];
    const expectedWorld = [
      affine[0][0] * u + affine[0][1] * v + affine[0][3],
      affine[1][0] * u + affine[1][1] * v + affine[1][3],
      affine[2][0] * u + affine[2][1] * v + affine[2][3],
    ];
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        Math.abs(properties.world_polygon_xyz[index][axis] - expectedWorld[axis]) < 1e-9,
        `WSI ROI world-coordinate mismatch at point ${index}, axis ${axis}`,
      );
  }
  const roiMeasurements = annotation.measurements;
  assert.ok(Object.keys(roiMeasurements).length > 0, "The WSI ROI has no measured table row");
  assert.ok(Object.values(roiMeasurements).every(
    (row) => row.annotation_id === "wsi-qa-roi" && row.sampled_voxel_count > 0,
  ));

  await selectTool(page, "Analyze", "Analyze");
  await waitForValue(
    () => page.locator(".research-result-table tbody tr").count(),
    (count) => count === roiRecord.measurements.length && count === roiResult.object_count,
    "the exact WSI mask object table",
  );
  await selectTool(page, "Results", "Info");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const reviewedSnapshot = await waitForValue(
    () => snapshot(page),
    (state) => state.results.some(
      (item) => item.id === roiResult.id && item.review?.disposition === "reviewed",
    ),
    "review of the exact WSI ROI revision",
  );
  const reviewedResult = reviewedSnapshot.results.find((item) => item.id === roiResult.id);
  assert.ok(reviewedResult, "The reviewed WSI ROI revision is absent");
  await page.getByRole("button", { name: "Export revision", exact: true }).click();
  const exportFiles = await waitForValue(
    () => fs.readdir(roiExportPath).catch(() => []),
    (names) => [
      "annotations.geojson",
      "roi-measurements.csv",
      "objects.csv",
      "manifest.json",
      "result.json",
    ].every((name) => names.includes(name)),
    "the atomic reviewed WSI ROI export",
  );
  const [exportedGeojson, roiCsv, objectCsv, exportedResult] = await Promise.all([
    fs.readFile(path.join(roiExportPath, "annotations.geojson"), "utf8").then(JSON.parse),
    fs.readFile(path.join(roiExportPath, "roi-measurements.csv"), "utf8"),
    fs.readFile(path.join(roiExportPath, "objects.csv"), "utf8"),
    fs.readFile(path.join(roiExportPath, "result.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(exportedGeojson.features, [annotation.geojson]);
  assert.ok(roiCsv.includes("wsi-qa-roi"));
  assert.equal(objectCsv.trim().split("\n").length, roiRecord.measurements.length + 1);
  assert.equal(exportedResult.result.id, roiResult.id);
  assert.equal(exportedResult.result.revision_hash, roiResult.revision_hash);
  assert.equal(exportedResult.review.disposition, "reviewed");
  const roiManifestFilesVerified = await verifyExportManifest(roiExportPath, roiResult);

  await selectAdvancedTool(page, "Import & share", "Import & share results");
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopenedSnapshot = await waitForValue(
    () => snapshot(page),
    (state) => state.sources.some((item) => item.sha256 === fixture.svs.sha256) &&
      state.results.some(
        (item) => item.id === roiResult.id &&
          item.revision_hash === roiResult.revision_hash &&
          item.review?.disposition === "reviewed",
      ),
    "reopen of the exact WSI ROI revision",
  );
  const reopenedRecord = await inspectResult(page, roiResult.id);
  assert.deepEqual(reopenedRecord.provenance.annotations, roiRecord.provenance.annotations);
  assert.deepEqual(reopenedRecord.provenance.selection, tissueRecord.provenance.selection);
  assert.deepEqual(reopenedRecord.measurements, roiRecord.measurements);
  await selectedSource(page, svsReport.file);
  const reopenedButton = page.locator(`[data-result-id="${roiResult.id}"]`);
  await waitForValue(
    () => reopenedButton.isEnabled(),
    Boolean,
    "enable the reopened WSI ROI revision",
  );
  await reopenedButton.click();
  await waitSelectedResult(page, roiResult.id, "select the reopened WSI ROI revision");
  await selectTool(page, "Analyze", "Analyze");
  await waitForValue(
    () => page.locator(".research-result-table tbody tr").count(),
    (count) => count === reopenedRecord.measurements.length,
    "the reopened WSI object table",
  );
  svsReport.roi_roundtrip = {
    result_id: roiResult.id,
    revision_hash: roiResult.revision_hash,
    parent_mask_id: adopted.id,
    parent_mask_revision_hash: adopted.revision_hash,
    review_revision_hash: reviewedResult.revision_hash,
    selection: roiRecord.provenance.selection,
    annotation_id: annotation.id,
    polygon_uv: properties.polygon_uv,
    world_polygon_xyz: properties.world_polygon_xyz,
    geometry_sha256: properties.geometry_sha256,
    roi_measurement_channels: Object.keys(roiMeasurements),
    mask_table_rows: roiRecord.measurements.length,
    export_files: exportFiles.sort(),
    manifest_files_verified: roiManifestFilesVerified,
    export_reopened_exactly: true,
  };
  svsReport.screenshots.push(await screenshot(page, "svs-roi-reopened"));
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  await timed(svsReport, rss, "classify-export-reopen-declared-stain-rule", () =>
    qualifyStainRule(page, svsReport, fixture.svs, tissueSelection, stainExportPaths[0], 9, 4));

  const ndpiReport = { file: path.basename(fixture.ndpi.file), steps: [] };
  sourceReports.push(ndpiReport);
  const ndpiFullFit = await selectedSource(page, ndpiReport.file);
  const ndpiSource = await sourceRecord(page, ndpiReport.file);
  assert.equal(ndpiSource.sha256, fixture.ndpi.sha256);
  const ndpiLevels = validatedLevels(ndpiSource, fixture.ndpi.levels);
  ndpiReport.levels = ndpiLevels;
  ndpiReport.coarse_level_available = true;
  assert.ok(ndpiFullFit.level > 0 && ndpiLevels.some((level) => level.index === ndpiFullFit.level),
    "The NDPI full fit did not select a declared native pyramid level automatically.");
  ndpiReport.full_source_camera = ndpiFullFit;
  // The analysis scope stays explicit while the image itself remains a
  // full-source camera with automatic native pyramid selection.
  selection = { level: 0, x: 8192, y: 6144, width: 1448, height: 1448 };
  await timed(ndpiReport, rss, "set-bounded-analysis-scope-without-moving-camera", () =>
    setSelection(page, ndpiReport.file, selection));
  ndpiReport.screenshots = [await screenshot(page, "ndpi-full-source-automatic-level")];
  const rapidDirections = ["ArrowRight", "ArrowDown", "ArrowRight", "ArrowUp"];
  const rapidStarted = performance.now();
  await timed(ndpiReport, rss, "rapid-latest-request-wins", async () => {
    const viewer = page.getByLabel(`Image viewer: ${ndpiReport.file}`);
    const before = await viewerState(page, ndpiReport.file);
    for (const direction of rapidDirections) await viewer.press(direction);
    const finalState = await waitViewport(page, ndpiReport.file,
      "NDPI rapid source-camera navigation", (state) =>
        state.camera.x !== before.camera.x || state.camera.y !== before.camera.y);
    await page.waitForTimeout(750);
    const settled = await waitViewport(page, ndpiReport.file, "settling rapid NDPI navigation");
    assert.deepEqual(settled.camera, finalState.camera,
      "A stale NDPI tile response changed the latest source camera.");
    assert.equal(settled.level, finalState.level,
      "A stale NDPI tile response changed the automatic pyramid level.");
    await noUiError(page, "settling rapid NDPI navigation");
    return finalState;
  });
  ndpiReport.rapid_navigation = {
    issued_camera_keys: rapidDirections,
    analysis_selection_unchanged: selection,
    elapsed_ms_including_stale_settle: Number((performance.now() - rapidStarted).toFixed(3)),
    observed_behavior: "latest full-source camera and automatic pyramid level remained active after bounded tile reads settled",
    stale_response_policy: "source-bound tile queue and camera state remained current",
    native_read_policy: "bounded automatic-pyramid tiles",
  };
  await timed(ndpiReport, rss, "native-pixel-camera-selects-level-0", () =>
    moveCamera(page, ndpiReport.file, "NDPI native-pixel source camera",
      (viewer) => viewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click(),
      (state) => state.level === 0));
  ndpiReport.screenshots.push(await screenshot(page, "ndpi-native-pixel-level-0"));
  await timed(ndpiReport, rss, "fit-camera-restores-automatic-coarse-level", () =>
    moveCamera(page, ndpiReport.file, "NDPI fitted source camera",
      (viewer) => viewer.locator(".image-view-tools").getByRole("button", { name: "Fit image" }).click(),
      (state) => state.level > 0));
  await timed(ndpiReport, rss, "automatic-level-pan-right", () =>
    moveCamera(page, ndpiReport.file, "NDPI automatic-level pan right",
      (viewer) => viewer.press("ArrowRight"),
      (state, before) => state.camera.x > before.camera.x));
  await timed(ndpiReport, rss, "automatic-level-pan-down", () =>
    moveCamera(page, ndpiReport.file, "NDPI automatic-level pan down",
      (viewer) => viewer.press("ArrowDown"),
      (state, before) => state.camera.y > before.camera.y));
  await timed(ndpiReport, rss, "automatic-level-zoom-in", () =>
    moveCamera(page, ndpiReport.file, "NDPI automatic-level zoom in",
      (viewer) => viewer.locator(".image-view-tools").getByRole("button", { name: "Zoom in" }).click(),
      (state, before) => state.camera.scale > before.camera.scale));
  ndpiReport.screenshots.push(await screenshot(page, "ndpi-automatic-level-panned-zoomed"));
  await timed(ndpiReport, rss, "classify-export-reopen-declared-stain-rule", () =>
    qualifyStainRule(page, ndpiReport, fixture.ndpi,
      { level: 0, x: 9344, y: 20568, width: 128, height: 128 }, stainExportPaths[1], 5, 1));

  assert.deepEqual(await dialogTrace(app), [
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "save", title: "Save research study as" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "open", title: "Open research study" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "open", title: "Open research study" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "open", title: "Open research study" },
  ]);
  assert.deepEqual(pageErrors, [], "Renderer page errors were observed");
  memory = await rss.stop();

  const expectedAfter = {};
  for (const [key, value] of Object.entries(fixture)) {
    expectedAfter[key] = await identity(value.file);
    assert.deepEqual(expectedAfter[key], expectedBefore[key], "Source identity changed: " + value.file);
  }
  const [tree, status, harnessIdentity, appIdentity, asarIdentity, workerIdentity] = await Promise.all([
    run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
    run("/usr/bin/git", ["status", "--short"], { cwd: projectRoot }),
    identity(harnessPath),
    identity(executablePath),
    identity(asarPath),
    identity(workerPath),
  ]);
  const report = {
    schema: "loci.whole-slide-packaged-workbench-qa/v1",
    status: "passed",
    generated_at_utc: new Date().toISOString(),
    tested_tree: tree.stdout.trim(),
    tested_working_tree_has_changes: status.stdout.trim().length > 0,
    tested_working_tree_status: status.stdout.trim().split("\n").filter(Boolean),
    harness: {
      file: path.relative(projectRoot, harnessPath),
      ...harnessIdentity,
    },
    app: { bundle: appBundle, executable: appIdentity, asar: asarIdentity, worker: workerIdentity },
    host: { platform: process.platform, arch: process.arch, release: os.release(), viewport_css: [1440, 1000] },
    paths: { run_root: runRoot, user_data: userData, study: studyPath, output: outputPath },
    dialogs: await dialogTrace(app),
    source_identity_before: expectedBefore,
    source_identity_after: expectedAfter,
    sources: sourceReports,
    memory,
    renderer_console_errors: consoleErrors,
    renderer_page_errors: pageErrors,
    scientific_scope: "Technical UI, coordinate, provenance, and resource qualification only; no biological, diagnostic, or accuracy validation.",
  };
  await fs.writeFile(path.join(outputPath, "qa-report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  if (!memory) memory = await rss.stop().catch(() => undefined);
  await screenshot(page, "failure").catch(() => undefined);
  await fs.writeFile(
    path.join(outputPath, "failure.json"),
    JSON.stringify({ error: String(error?.stack ?? error), memory, pageErrors, consoleErrors }, null, 2) + "\n",
  ).catch(() => undefined);
  throw error;
} finally {
  await app.close().catch(() => undefined);
}
