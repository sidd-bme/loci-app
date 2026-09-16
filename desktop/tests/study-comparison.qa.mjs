import assert from "node:assert/strict";
import { createEmptyStudy, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
if (process.platform !== "darwin")
  throw new Error("The study-comparison packaged journey currently requires macOS.");

const appBundle = path.resolve(
  process.env.LOCI_PACKAGED_APP ??
    path.join(desktopRoot, "..", ".loci", "builds", "current", "Loci.app",),
);
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const resourcesPath = path.join(appBundle, "Contents", "Resources");
const workerPath = path.join(resourcesPath, "loci-engine", "loci-engine");
const asarPath = path.join(resourcesPath, "app.asar");
const harnessPath = path.resolve(import.meta.filename);
const startedAt = new Date().toISOString();
const runName = startedAt.replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(projectRoot, ".loci", "qa"),
  "study-comparison-" + runName,
);
const userData = path.join(runRoot, "user-data");
const fixtureRoot = path.join(runRoot, "fixtures");
const studyPath = path.join(runRoot, "study", "comparison.loci-study");
const archivePath = path.join(runRoot, "portable", "comparison.loci-study.zip");
const importedStudyPath = path.join(
  runRoot,
  "imported",
  "comparison-imported.loci-study",
);
const screenshotsPath = path.join(runRoot, "screenshots");
const fixtures = {
  first: path.join(fixtureRoot, "replicate-a.tif"),
  second: path.join(fixtureRoot, "replicate-b.tif"),
};

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function identity(file) {
  const stat = await fs.stat(file);
  assert.ok(stat.isFile(), "Expected a regular build artifact: " + file);
  return { sha256: await sha256(file), size_bytes: stat.size };
}

async function buildIdentity() {
  return {
    executable: await identity(executablePath),
    app_asar: await identity(asarPath),
    worker: await identity(workerPath),
  };
}

function writeGray8Tiff(file, width, height, pixels) {
  assert.equal(pixels.length, width * height);
  const entries = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, 134],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixels.length],
    [284, 3, 1, 1],
  ];
  const output = Buffer.alloc(134 + pixels.length);
  output.write("II", 0, "ascii");
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(8, 4);
  output.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    output.writeUInt16LE(tag, offset);
    output.writeUInt16LE(type, offset + 2);
    output.writeUInt32LE(count, offset + 4);
    if (type === 3) output.writeUInt16LE(value, offset + 8);
    else output.writeUInt32LE(value, offset + 8);
  });
  output.writeUInt32LE(0, 130);
  Buffer.from(pixels).copy(output, 134);
  return fs.writeFile(file, output);
}

function oneObject(width) {
  const pixels = new Uint8Array(12 * 12);
  for (let y = 3; y < 7; y++)
    for (let x = 2; x < 2 + width; x++) pixels[y * 12 + x] = 100;
  return pixels;
}

await Promise.all([
  fs.mkdir(fixtureRoot, { recursive: true }),
  fs.mkdir(path.dirname(studyPath), { recursive: true }),
  fs.mkdir(path.dirname(archivePath), { recursive: true }),
  fs.mkdir(path.dirname(importedStudyPath), { recursive: true }),
  fs.mkdir(screenshotsPath, { recursive: true }),
  fs.access(executablePath, fs.constants.X_OK),
  fs.access(workerPath, fs.constants.X_OK),
]);
await Promise.all([
  writeGray8Tiff(fixtures.first, 12, 12, oneObject(4)),
  writeGray8Tiff(fixtures.second, 12, 12, oneObject(8)),
]);
const fixtureIdentities = Object.fromEntries(
  await Promise.all(
    Object.entries(fixtures).map(async ([name, file]) => [name, await identity(file)]),
  ),
);
const buildBefore = await buildIdentity();
const git = async (...args) =>
  (await run("git", args, { cwd: projectRoot })).stdout.trim();
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  tree: await git("rev-parse", "HEAD^{tree}"),
  status: await git("status", "--porcelain"),
  harness_sha256: await sha256(harnessPath),
};

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(action + ": " + ((await alert.textContent()) ?? "unknown UI error"));
}

async function waitForValue(read, accept, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function screenshot(page, name) {
  const destination = path.join(screenshotsPath, name + ".png");
  const bounds = await page.evaluate(() => ({
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    body: {
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.body.clientWidth,
    },
  }));
  assert.ok(
    bounds.document.scrollWidth <= bounds.document.clientWidth + 1,
    `Document overflowed before ${name}: ${JSON.stringify(bounds.document)}`,
  );
  assert.ok(
    bounds.body.scrollWidth <= bounds.body.clientWidth + 1,
    `Body overflowed before ${name}: ${JSON.stringify(bounds.body)}`,
  );
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: "instant" }));
  await page.screenshot({ path: destination, fullPage: true });
  return destination;
}

async function launch() {
  const app = await electron.launch({
    executablePath,
    args: ["--user-data-dir=" + userData],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 800 });
  });
  return app;
}

async function installDialogs(app) {
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Add microscopy or medical images")
          return { canceled: false, filePaths: values.sources };
        if (options?.title === "Open research study")
          return { canceled: false, filePaths: [values.study] };
        if (options?.title === "Import portable Loci study")
          return { canceled: false, filePaths: [values.archive] };
        return { canceled: true, filePaths: [] };
      };
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Create research study")
          return { canceled: false, filePath: values.study };
        if (options?.title === "Export portable study with derived results")
          return { canceled: false, filePath: values.archive };
        if (options?.title === "Choose a new study directory")
          return { canceled: false, filePath: values.importedStudy };
        return { canceled: true, filePath: undefined };
      };
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    {
      sources: Object.values(fixtures),
      study: studyPath,
      archive: archivePath,
      importedStudy: importedStudyPath,
    },
  );
}

async function snapshot(page) {
  return page.evaluate(() => window.lociResearch.getSnapshot());
}

async function close(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
}

async function selectSource(page, name) {
  const selected = page.locator(".research-sources").getByRole("button", { name });
  await selected.click();
  await noUiError(page, "selecting " + name);
}

async function saveMetadata(page, name, values) {
  await selectSource(page, name);
  await selectWorkbenchTool(page, "Info");
  await page.getByText("Study metadata", { exact: true }).click();
  for (const [field, value] of Object.entries(values))
    await page.getByLabel(field, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  await waitForValue(
    () => snapshot(page),
    (state) => state.samples.some(
      (sample) => sample.data.biological_replicate === values.biological_replicate,
    ),
    "saved sample metadata",
  );
}

async function runRecipe(page, sourceName, sourceId) {
  await selectSource(page, sourceName);
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Threshold", { exact: true }).fill("50");
  const before = new Set((await snapshot(page)).results.map((item) => item.id));
  await page.getByRole("button", { name: "Run recipe", exact: true }).click();
  const state = await waitForValue(
    () => snapshot(page),
    (next) => next.results.some(
      (item) => item.source_id === sourceId && !before.has(item.id),
    ),
    "one completed versioned run",
  );
  const result = state.results.find(
    (item) => item.source_id === sourceId && !before.has(item.id),
  );
  assert.equal(result.object_count, 1);
  return result;
}

async function setReview(page, result, disposition) {
  await selectWorkbenchTool(page, "Study");
  await page.getByLabel(`Mark ${result.id} ${disposition}`).click();
  await waitForValue(
    () => snapshot(page),
    (state) => state.results.some(
      (item) => item.id === result.id && item.review?.disposition === disposition,
    ),
    `${disposition} review for ${result.id}`,
  );
}

async function selectComparison(page, left, right) {
  await selectWorkbenchTool(page, "Study");
  for (const result of left)
    await page.getByLabel(`Include ${result.id} in run A`).check();
  for (const result of right)
    await page.getByLabel(`Include ${result.id} in run B`).check();
  await page.getByRole("button", { name: "Compare run A with run B", exact: true }).click();
  const table = page.getByRole("table", { name: "Study run comparison", exact: true });
  await table.waitFor({ state: "visible", timeout: 120_000 });
  await table.scrollIntoViewIfNeeded();
  await noUiError(page, "comparing the two exact run groups");
  const cells = await table.locator("tbody tr").first().locator("td").allTextContents();
  assert.deepEqual(cells, ["control", "24", "32", "8", "2", "1"]);
}

let app = await launch();
let page = await app.firstWindow();
let left;
let right;
let firstReceipt;
try {
  await installDialogs(app);
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await createEmptyStudy(page);
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const importedStudy = await waitForValue(
    () => snapshot(page),
    (state) => state.sources.length === 2,
    "two synthetic study sources",
  );
  const firstSource = importedStudy.sources.find((item) => item.name === "replicate-a.tif");
  const secondSource = importedStudy.sources.find((item) => item.name === "replicate-b.tif");
  assert.ok(firstSource && secondSource, "The two owned fixtures were not imported exactly.");

  await saveMetadata(page, "replicate-a.tif", {
    sample: "section-a",
    condition: "control",
    biological_replicate: "animal-1",
    plate: "plate-1",
    well: "A1",
  });
  await saveMetadata(page, "replicate-b.tif", {
    sample: "section-b",
    condition: "control",
    biological_replicate: "animal-2",
    plate: "plate-1",
    well: "A2",
  });

  const firstA = await runRecipe(page, "replicate-a.tif", firstSource.id);
  const secondA = await runRecipe(page, "replicate-a.tif", firstSource.id);
  const firstB = await runRecipe(page, "replicate-b.tif", secondSource.id);
  const secondB = await runRecipe(page, "replicate-b.tif", secondSource.id);
  left = [firstA, firstB];
  right = [secondA, secondB];
  assert.equal(new Set([...left, ...right].map((item) => item.id)).size, 4);
  assert.equal(firstA.revision_hash === secondA.revision_hash, false);
  assert.equal(firstB.revision_hash === secondB.revision_hash, false);

  await setReview(page, firstA, "reviewed");
  await setReview(page, firstB, "reviewed");
  await setReview(page, secondA, "excluded");
  await setReview(page, secondB, "reviewed");
  await selectComparison(page, left, right);
  await screenshot(page, "comparison");

  const request = {
    left_result_ids: left.map((item) => item.id),
    right_result_ids: right.map((item) => item.id),
    value: "measure",
  };
  firstReceipt = await page.evaluate(
    (payload) => window.lociResearch.execute("study_compare", payload),
    request,
  );
  assert.equal(firstReceipt.schema, "loci.study-run-comparison/v1");
  assert.equal(firstReceipt.p_values, null);
  assert.deepEqual(firstReceipt.comparisons, [{
    condition: "control",
    left_mean: 24,
    right_mean: 32,
    difference: 8,
    left_n_biological_replicates: 2,
    right_n_biological_replicates: 1,
  }]);
  assert.deepEqual(
    firstReceipt.left.bindings.map((item) => item.result_id),
    request.left_result_ids,
  );
  assert.deepEqual(
    firstReceipt.right.bindings.map((item) => item.result_id),
    request.right_result_ids,
  );
  assert.equal(firstReceipt.right.bindings[0].review.disposition, "excluded");
  assert.match(firstReceipt.independent_n_basis, /biological replicate means/u);
  assert.match(firstReceipt.receipt_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(firstReceipt.comparison_document, {
    id: firstReceipt.receipt_sha256.slice(0, 32),
    revision: 1,
  });
  const saved = await snapshot(page);
  assert.equal(saved.comparisons.length, 1);
  assert.deepEqual(saved.comparisons[0].data.receipt, Object.fromEntries(
    Object.entries(firstReceipt).filter(([key]) => key !== "comparison_document"),
  ));
  await selectWorkbenchTool(page, "Portability");
  await page.getByRole("button", { name: "Export portable study", exact: true }).click();
  await waitForValue(
    () => fs.stat(archivePath).then((stat) => stat.size).catch(() => 0),
    (size) => size > 0,
    "portable study archive",
  );
  const archiveIdentity = await identity(archivePath);
  await close(app);

  app = await launch();
  page = await app.firstWindow();
  await installDialogs(app);
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const reopened = await snapshot(page);
  for (const expected of [...left, ...right]) {
    const retained = reopened.results.find((item) => item.id === expected.id);
    assert.equal(retained?.revision_hash, expected.revision_hash);
  }
  await selectWorkbenchTool(page, "Study");
  const reopenedTable = page.getByRole("table", {
    name: "Study run comparison",
    exact: true,
  });
  await reopenedTable.waitFor({ state: "visible", timeout: 120_000 });
  await reopenedTable.scrollIntoViewIfNeeded();
  const reopenedReceipt = await page.evaluate(
    (payload) => window.lociResearch.execute("study_compare", payload),
    request,
  );
  assert.deepEqual(reopenedReceipt, firstReceipt);
  await screenshot(page, "comparison-reopened");

  await selectWorkbenchTool(page, "Portability");
  await page.getByRole("button", { name: "Import portable study", exact: true }).click();
  const imported = await waitForValue(
    () => snapshot(page),
    (state) => state.sources.length === 2 &&
      state.sources.every((source) => source.locator_state === "relink-required") &&
      state.comparisons?.length === 1,
    "fresh imported study with retained comparison",
  );
  assert.deepEqual(imported.comparisons[0], reopened.comparisons[0]);
  await selectWorkbenchTool(page, "Study");
  const importedTable = page.getByRole("table", {
    name: "Study run comparison",
    exact: true,
  });
  await importedTable.waitFor({ state: "visible", timeout: 120_000 });
  await importedTable.scrollIntoViewIfNeeded();
  const importedReceipt = await page.evaluate(
    (payload) => window.lociResearch.execute("study_compare", payload),
    request,
  );
  assert.deepEqual(importedReceipt, firstReceipt);
  await screenshot(page, "comparison-imported");
  await close(app);

  assert.deepEqual(await buildIdentity(), buildBefore);
  for (const [name, file] of Object.entries(fixtures))
    assert.deepEqual(await identity(file), fixtureIdentities[name]);
  const report = {
    schema: "loci.study-comparison-packaged-qa/v1",
    status: "passed",
    app_bundle: appBundle,
    study_path: studyPath,
    source: sourceIdentity,
    build: buildBefore,
    fixtures: fixtureIdentities,
    hardware: {
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      total_memory_bytes: os.totalmem(),
    },
    review: {
      left: left.map((item) => ({ id: item.id, revision_hash: item.revision_hash })),
      right: right.map((item) => ({ id: item.id, revision_hash: item.revision_hash })),
      excluded_result_id: right[0].id,
    },
    receipt: firstReceipt,
    reopen_exact: true,
    portable_archive: archiveIdentity,
    imported_study_path: importedStudyPath,
    import_exact: true,
    screenshots: (await fs.readdir(screenshotsPath)).sort(),
    started_at: startedAt,
  };
  await fs.writeFile(
    path.join(runRoot, "qa-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  await screenshot(page, "failure").catch(() => undefined);
  await fs.writeFile(
    path.join(runRoot, "failure-ui.txt"),
    await page.locator("body").innerText().catch(() => "UI unavailable"),
  );
  throw error;
} finally {
  await app.close().catch(() => undefined);
}
