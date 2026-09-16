import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { qualifyExtendedWorkflows } from "./research-extended-workflows.qa.mjs";
import { qualifyMedicalWorkflow } from "./research-medical-workflow.qa.mjs";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const fixtureRoot = process.env.LOCI_QA_RESEARCH_FIXTURES
  ? path.resolve(process.env.LOCI_QA_RESEARCH_FIXTURES)
  : null;
if (!fixtureRoot)
  throw new Error(
    "Set LOCI_QA_RESEARCH_FIXTURES to an explicit fixture directory.",
  );
if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error("Research packaged QA supports macOS and Windows only.");
}

const defaultBundle =
  process.platform === "darwin"
    ? path.join(
        desktopRoot, "..", ".loci", "builds", "current", "Loci.app",
      )
    : path.join(desktopRoot, "out", "local-unsigned", "Loci-win32-x64");
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? defaultBundle);
const executablePath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "MacOS", "Loci")
    : path.join(appBundle, "Loci.exe");
const workerPath =
  process.platform === "darwin"
    ? path.join(
        appBundle,
        "Contents",
        "Resources",
        "loci-engine",
        "loci-engine",
      )
    : path.join(appBundle, "resources", "loci-engine", "loci-engine.exe");
const archivePath = process.platform === "darwin"
  ? path.join(appBundle, "Contents", "Resources", "app.asar")
  : path.join(appBundle, "resources", "app.asar");
const startedAt = new Date().toISOString();
const startTime = performance.now();
const checkpoints = [];
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function workingSourceSha256() {
  const { stdout } = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const digest = createHash("sha256");
  for (const relative of stdout.split("\0").filter(Boolean).sort()) {
    const file = path.join(projectRoot, relative);
    const status = await fs.lstat(file).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    digest.update(relative).update("\0");
    if (!status) digest.update("deleted\0");
    else if (status.isSymbolicLink())
      digest.update("symlink\0").update(await fs.readlink(file)).update("\0");
    else if (status.isFile())
      digest.update("file\0").update(await sha256(file)).update("\0");
    else digest.update(`unsupported-${status.mode}\0`);
  }
  return digest.digest("hex");
}
async function buildIdentity() {
  return {
    executable_sha256: await sha256(executablePath),
    worker_sha256: await sha256(workerPath),
    asar_sha256: await sha256(archivePath),
  };
}
const buildBefore = await buildIdentity();
const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  tree: await git("rev-parse", "HEAD^{tree}"),
  working_source_sha256: await workingSourceSha256(),
  status: await git("status", "--porcelain"),
  harness_sha256: await sha256(path.join(import.meta.dirname, "research-workbench.qa.mjs")),
  extended_harness_sha256: await sha256(path.join(import.meta.dirname, "research-extended-workflows.qa.mjs")),
  medical_harness_sha256: await sha256(path.join(import.meta.dirname, "research-medical-workflow.qa.mjs")),
};

const runName = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const runRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(projectRoot, ".loci", "qa"),
  "research-" + runName,
);
const userData = path.join(runRoot, "user-data");
const studyPath = path.join(runRoot, "research-workbench.loci-study");
const exportPath = path.join(runRoot, "reviewed-3d-result");
const screenshots = path.join(runRoot, "screenshots");
const fixture = {
  volume: path.join(fixtureRoot, "anisotropic_tczyx_two_objects.ome.tiff"),
  rgb: path.join(fixtureRoot, "declared_h_dab_rgb.tiff"),
  nifti: path.join(fixtureRoot, "oblique_scalar.nii"),
  multiplex: path.join(fixtureRoot, "multiplex_translating_objects.ome.tiff"),
};
await Promise.all([
  fs.mkdir(userData, { recursive: true }),
  fs.mkdir(screenshots, { recursive: true }),
  ...Object.values(fixture).map((value) => fs.access(value)),
]);
const fixtureHashes = Object.fromEntries(await Promise.all(
  Object.entries(fixture).map(async ([name, file]) => [name, await sha256(file)]),
));

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    const text = (await alert.textContent()) ?? "unknown research UI error";
    if (text.includes("relink an exact local copy") || text.includes("relink-required")) return;
    throw new Error(action + ": " + text);
  }
}
async function visible(page, locator, label, timeout = 30_000) {
  await locator.waitFor({ state: "visible", timeout });
  await noUiError(page, "waiting for " + label);
  return locator;
}
async function rows(page, count, unit) {
  const tableRows = page.locator(".research-result-table tbody tr");
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".research-result-table tbody tr").length ===
      expected,
    count,
    { timeout: 120_000 },
  );
  assert.equal(await tableRows.count(), count);
  await visible(
    page,
    page
      .locator(".research-result-table")
      .getByText(unit, { exact: true })
      .first(),
    unit,
    30_000,
  );
}
async function assertRowValues(page, values) {
  const actual = await page
    .locator(".research-result-table tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.querySelectorAll("td")[1].textContent)),
    );
  assert.deepEqual(actual, values);
}
async function assertFileExists(file) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Expected published file is absent: " + file);
}
async function screenshot(page, name) {
  process.stdout.write("Checkpoint: " + name + "\n");
  const output = path.join(screenshots, name + ".png");
  await page.screenshot({ path: output, fullPage: true });
  checkpoints.push({ name, elapsed_seconds: (performance.now() - startTime) / 1000 });
  return output;
}
async function launch() {
  const instance = await electron.launch({
    executablePath,
    args: ["--user-data-dir=" + userData],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 720 });
  });
  return instance;
}
async function installDialogs(app) {
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Add microscopy or medical images") {
          return { canceled: false, filePaths: values.sources };
        }
        if (options?.title === "Open research study") {
          return { canceled: false, filePaths: [values.study] };
        }
        return { canceled: true, filePaths: [] };
      };
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Save research study as") {
          return { canceled: false, filePath: values.study };
        }
        if (options?.title === "Export reviewed result bundle") {
          return { canceled: false, filePath: values.export };
        }
        return { canceled: true, filePath: undefined };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    {
      sources: [fixture.volume, fixture.rgb, fixture.nifti, fixture.multiplex],
      study: studyPath,
      export: exportPath,
    },
  );
}
async function close(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  const done = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await done;
}
async function cliSnapshot() {
  const { stdout } = await run(
    workerPath,
    ["--cli", "snapshot", "--project", studyPath],
    {
      timeout: 60_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

const toolGroup = {
  Display: "View",
  Annotate: "Annotate",
  Correction: "Annotate",
  Process: "Analyze",
  Analyze: "Analyze",
  Quantify: "Analyze",
  Temporal: "Analyze",
  Registration: "Analyze",
  Agent: "Analyze",
  Remote: "Analyze",
  Model: "Analyze",
  Study: "Results",
  Portability: "Results",
  Info: "Results",
};
async function selectTool(page, tool) {
  const group = toolGroup[tool];
  assert.ok(group, `Unknown workbench tool ${tool}`);
  await selectWorkbenchTool(page, tool);
}
async function openAnalysisRegion(page) {
  const details = page.locator("details.analysis-region-settings");
  if (!await details.evaluate((element) => element.open)) {
    await details.locator("summary").click();
  }
}

let app = await launch();
let page = await app.firstWindow();
try {
  await visible(page, page.locator("main.image-first-empty"), "image-first welcome");
  await installDialogs(app);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "research workspace",
  );
  await visible(
    page,
    page
      .locator(".research-sources")
      .getByRole("button", {
        name: /^anisotropic_tczyx_two_objects\.ome\.tiff/,
      }),
    "volume source",
  );
  await visible(
    page,
    page
      .locator(".research-sources")
      .getByRole("button", { name: /^declared_h_dab_rgb\.tiff/ }),
    "RGB source",
  );
  await visible(
    page,
    page
      .locator(".research-sources")
      .getByRole("button", { name: /^oblique_scalar\.nii/ }),
    "NIfTI source",
  );
  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await assertFileExists(path.join(studyPath, "study.sqlite3"));
  await screenshot(page, "imported");

  // T/C/Z controls and real orthogonal crop selection operate on the scalar OME source.
  await openAnalysisRegion(page);
  await page.getByLabel("C", { exact: true }).fill("0");
  await page.getByLabel("T", { exact: true }).fill("0");
  await page.getByLabel("Z", { exact: true }).fill("1");
  await page.getByLabel("Display scope").selectOption("max");
  await page.getByLabel("Z stop", { exact: true }).fill("3");
  await page
    .getByRole("button", { name: "Load linked orthogonal crop" })
    .click();
  await visible(
    page,
    page.getByAltText("XZ orthogonal plane"),
    "orthogonal crop",
  );
  await page
    .getByRole("button", { name: "Select XZ crosshair" })
    .click({ position: { x: 15, y: 15 } });
  await noUiError(page, "orthogonal crosshair");
  await screenshot(page, "volume-navigation");

  // First run is one native Z plane (2D), then the explicit z_stop creates a 3D result.
  await page.getByLabel("Display scope").selectOption("plane");
  await page
    .locator(".research-sources")
    .getByRole("button", { name: /^declared_h_dab_rgb\.tiff/ })
    .click();
  await page
    .locator(".research-sources")
    .getByRole("button", { name: /^anisotropic_tczyx_two_objects\.ome\.tiff/ })
    .click();
  await openAnalysisRegion(page);
  await page.getByLabel("Z", { exact: true }).fill("1");
  await selectTool(page, "Analyze");
  await page.getByLabel("Threshold", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Run recipe" }).click();
  await rows(page, 2, "um^2");
  await assertRowValues(page, [10, 18]);
  await screenshot(page, "two-dimensional-result");
  await selectTool(page, "Display");
  await openAnalysisRegion(page);
  await page.getByLabel("Z", { exact: true }).fill("0");
  await page.getByLabel("Display scope").selectOption("max");
  await page.getByLabel("Z stop", { exact: true }).fill("3");
  await selectTool(page, "Analyze");
  await page.getByRole("button", { name: "Run recipe" }).click();
  await rows(page, 2, "um^3");
  await assertRowValues(page, [60, 108]);
  await screenshot(page, "three-dimensional-result");

  // An exact result must be reviewed through the displayed UI before export.
  await selectTool(page, "Info");
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await noUiError(page, "reviewing 3D result");
  await page.getByRole("button", { name: "Export revision" }).click();
  await assertFileExists(path.join(exportPath, "manifest.json"));

  // RGB is selected as a declared brightfield source.  The UI must never call RGB
  // components biological channels; it requires an explicit H-DAB declaration.
  await page
    .locator(".research-sources")
    .getByRole("button", { name: /^declared_h_dab_rgb\.tiff/ })
    .click();
  await selectTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("stain");
  await visible(
    page,
    page.getByLabel("Stain basis"),
    "declared histology controls",
  );
  await page.getByLabel("Stain basis").selectOption("H-DAB");
  await page.getByLabel("Stain component").selectOption("1");
  await page.getByLabel("Enable stain measurement rule").check();
  await page.getByLabel("Stain rule name").fill("Declared technical DAB rule");
  await page.getByLabel("Stain rule channel").selectOption("1");
  await page.getByLabel("Stain rule threshold").fill("0.01");
  await page.getByLabel("Stain rule control or evidence").fill("Synthetic RGB patches; technical rule only.");
  await page.getByRole("button", { name: "Preview declared stain" }).click();
  await rows(page, 1, "pixel^2");
  await assertRowValues(page, [90]);
  await page.getByRole("button", { name: "Run declared stain" }).click();
  await visible(
    page,
    page
      .locator(".research-sources")
      .getByRole("button", { name: /^declared-stain-analysis/ }),
    "durable histology result",
  );
  await noUiError(page, "running declared histology");
  await screenshot(page, "declared-h-dab");
  const stainState = await page.evaluate(() => window.lociResearch.getSnapshot());
  const stainResult = stainState.results.find((item) => item.kind === "declared-stain-analysis");
  const stainRecord = await page.evaluate((result_id) => window.lociResearch.execute("result", { result_id }), stainResult.id);
  assert.deepEqual(stainRecord.provenance.recipe.gates, [{
    name: "Declared technical DAB rule", channel: "DAB-basis", statistic: "mean",
    threshold: 0.01, control: "Synthetic RGB patches; technical rule only.",
  }]);
  assert.ok(stainRecord.measurements.length > 0);
  assert.ok(stainRecord.measurements.every((row) => typeof row.marker_gates["Declared technical DAB rule"] === "boolean"));
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  await page.getByLabel("Tissue control or review criterion").fill("Synthetic blank background and dark patches; technical QA.");
  await page.getByRole("button", { name: "Preview tissue mask", exact: true }).click();
  await page.getByRole("button", { name: "Adopt tissue mask", exact: true }).waitFor();
  await page.getByRole("button", { name: "Adopt tissue mask", exact: true }).click();
  await visible(page, page.locator(".research-sources").getByRole("button", { name: /^tissue-region-mask/ }), "adopted tissue regions");
  await noUiError(page, "adopting tissue regions");
  await screenshot(page, "tissue-regions");

  // Saved recipes are validated against their source.  Batch only includes the
  // compatible source and still requires a displayed preview before the run.
  await page
    .locator(".research-sources")
    .getByRole("button", { name: /^anisotropic_tczyx_two_objects\.ome\.tiff/ })
    .click();
  await selectTool(page, "Study");
  await page
    .getByLabel("Study recipe name")
    .fill("Synthetic anisotropic recipe");
  await page.getByRole("button", { name: "Save validated recipe" }).click();
  await visible(page, page.getByRole("button", { name: "Restore saved recipe Synthetic anisotropic recipe", exact: true }), "saved reusable recipe");
  await noUiError(page, "saving recipe");
  const batchCheckbox = page.getByLabel("Include anisotropic_tczyx_two_objects.ome.tiff in batch");
  await batchCheckbox.scrollIntoViewIfNeeded();
  const checkboxBounds = await batchCheckbox.boundingBox();
  assert.ok(checkboxBounds && checkboxBounds.width >= 14 && checkboxBounds.height >= 14,
    "A long source name must not collapse its batch checkbox at the minimum window size");
  await batchCheckbox.check();
  await page
    .getByRole("button", { name: "Preview", exact: true })
    .first()
    .click();
  await noUiError(page, "batch preview");
  await page
    .getByRole("button", { name: "Run selected sources sequentially" })
    .click();
  await visible(page, page.getByText(/succeeded|completed/), "batch completion", 120_000);
  await screenshot(page, "study-batch");

  const medical = await qualifyMedicalWorkflow({ app, page, runRoot, noUiError, screenshot });
  const extended = await qualifyExtendedWorkflows({
    app, page, runRoot, fixture, noUiError, screenshot,
  });

  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workbench: box(".research-workbench"),
      sources: box(".research-sources"),
      canvas: box(".research-canvas"),
      inspector: box(".research-inspector"),
      overflow: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    };
  });
  assert.ok(
    layout.workbench && layout.sources && layout.canvas && layout.inspector,
    "research layout regions are missing",
  );
  assert.ok(
    layout.overflow.width <= layout.viewport.width + 1,
    "research UI has global horizontal overflow",
  );
  assert.ok(
    layout.overflow.height <= layout.viewport.height + 1,
    "research UI has global vertical overflow",
  );
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    electron: process.versions.electron,
    platform: process.platform,
    runtime: process.versions,
    version: electronApp.getVersion(),
  }));
  await close(app);

  // Reopen through the packaged UI, then inspect the same project with the
  // bundled local CLI.  CLI evidence supplements, never replaces, UI actions.
  app = await launch();
  page = await app.firstWindow();
  await installDialogs(app);
  const empty = page.locator("main.image-first-empty");
  const workbench = page.locator("main.image-first-workbench");
  await Promise.race([
    empty.waitFor({ state: "visible", timeout: 30_000 }),
    workbench.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await empty.isVisible()) {
    await page.getByRole("button", { name: "Open study", exact: true }).click();
  }
  await visible(page, workbench, "reopened application");
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "reopened study",
  );
  await visible(
    page,
    page
      .locator(".research-sources")
      .getByRole("button", {
        name: /^anisotropic_tczyx_two_objects\.ome\.tiff/,
      }),
    "reopened source",
  );
  await screenshot(page, "reopened");
  await close(app);

  const snapshot = await cliSnapshot();
  assert.ok(
    snapshot.results.length >= 4,
    "expected 2D, 3D, histology, and batch durable results",
  );
  assert.ok(
    snapshot.results.some((item) => item.kind === "declared-stain-analysis"),
    "declared histology result is absent",
  );
  assert.ok(snapshot.results.some((item) => item.kind === "tissue-region-mask"), "tissue region result is absent");
  assert.ok(
    snapshot.results.some((item) => item.object_count === 2),
    "exact two-object result is absent",
  );

  assert.deepEqual(await buildIdentity(), buildBefore, "The packaged app changed during qualification");
  for (const [name, file] of Object.entries(fixture))
    assert.equal(await sha256(file), fixtureHashes[name], "The source fixture changed: " + name);
  const report = {
    schema: "loci.research-workbench-packaged-qa/v1",
    appBundle,
    fixtureRoot,
    fixture_sha256: fixtureHashes,
    build: buildBefore,
    source: sourceIdentity,
    invocation: { command: "node tests/research-workbench.qa.mjs", fixture_root: fixtureRoot, output_root: runRoot, app_bundle: appBundle },
    hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem() },
    timing: { started_at: startedAt, elapsed_seconds: (performance.now() - startTime) / 1000, checkpoints },
    layout,
    runtime,
    extended,
    medical,
    screenshots: await fs.readdir(screenshots),
    studyPath,
    resultCount: snapshot.results.length,
    sourceCount: snapshot.sources.length,
    status: "passed",
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
    await page
      .locator("body")
      .innerText()
      .catch(() => "UI unavailable"),
  );
  throw error;
} finally {
  await app.close().catch(() => undefined);
}
