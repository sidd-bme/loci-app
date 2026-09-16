import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ??
    path.resolve(import.meta.dirname, "../../.loci/evidence/qa/epidermis-workflow"),
);
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(outputRoot, runName);
const screenshotsRoot = path.join(runRoot, "screenshots");
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const initialUserData = path.join(runRoot, "user-data-initial");
const reopenUserData = path.join(runRoot, "user-data-reopen");
const fixturePath = path.join(fixtureRoot, "synthetic-epidermis-tz-rgb.ome.tiff");
const csvPath = path.join(runRoot, "synthetic-epidermis-tz-rgb.ome-transects.csv");
const studyPath = path.join(runRoot, "epidermis-workflow.loci-study");
const receiptPath = path.join(runRoot, "epidermis-workflow-receipt.json");
const failurePath = path.join(runRoot, "epidermis-workflow-failure.json");
const packagedAppInput = process.env.LOCI_PACKAGED_APP ?? process.env.LOCI_QA_APP ?? null;

if (
  process.env.LOCI_PACKAGED_APP &&
  process.env.LOCI_QA_APP &&
  process.env.LOCI_PACKAGED_APP !== process.env.LOCI_QA_APP
) {
  throw new Error("LOCI_PACKAGED_APP and its LOCI_QA_APP alias disagree.");
}
if (packagedAppInput && !path.isAbsolute(packagedAppInput)) {
  throw new Error("LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
}
const packagedApp = packagedAppInput ? path.resolve(packagedAppInput) : null;
const packaged = packagedApp !== null;
if (packaged === (process.env.LOCI_QA_DEV === "1")) {
  throw new Error(
    "Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.",
  );
}
if (process.platform !== "darwin") {
  throw new Error("The epidermis workflow journey currently qualifies macOS Electron builds.");
}

const executablePath = packaged
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
const workerPath = packaged
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const mainArtifact = packaged
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const independentPython = path.join(projectRoot, "engine", ".venv", "bin", "python");

const savedProtocol = {
  class: "suprapapillary",
  upper_boundary: "Viable epidermis upper boundary",
  lower_boundary: "Dermal-epidermal junction",
  orientation_rule: "Perpendicular to local basement membrane",
  exclusions: "Exclude tears, folds, and appendages",
  reviewer: "QA Reviewer",
  label: "QA calibrated transect",
};
const unsavedProtocol = {
  upper_boundary: "UNSAVED current upper boundary",
  lower_boundary: "UNSAVED current lower boundary",
  orientation_rule: "UNSAVED current orientation",
  exclusions: "UNSAVED current exclusions",
  reviewer: "UNSAVED Current Reviewer",
  label: "UNSAVED current label",
};

const startedAt = new Date().toISOString();
const captures = {};
const pageErrors = [];
const consoleErrors = [];
let app;
let page;
let sourceIdentity;
let buildIdentity;
let fixtureIdentity;
let journey = {};

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function generateFixture() {
  const generator = path.join(runRoot, "generate_epidermis_fixture.py");
  await fs.writeFile(
    generator,
    String.raw`from pathlib import Path
import numpy as np
import tifffile

output = Path(${JSON.stringify(fixturePath)})
t, z, height, width = 2, 2, 120, 160
yy, xx = np.ogrid[:height, :width]
image = np.empty((t, z, height, width, 3), dtype=np.uint8)
for ti in range(t):
    for zi in range(z):
        image[ti, zi, ..., 0] = (xx + ti * 29 + zi * 11) % 256
        image[ti, zi, ..., 1] = (yy * 2 + ti * 17 + zi * 37) % 256
        image[ti, zi, ..., 2] = ((xx // 8 + yy // 6 + ti + zi) % 2) * 96 + 80
tifffile.imwrite(
    output,
    image,
    ome=True,
    photometric="rgb",
    metadata={
        "axes": "TZYXS",
        "PhysicalSizeX": 0.5,
        "PhysicalSizeXUnit": "µm",
        "PhysicalSizeY": 0.8,
        "PhysicalSizeYUnit": "µm",
        "PhysicalSizeZ": 2.0,
        "PhysicalSizeZUnit": "µm",
        "TimeIncrement": 1.0,
        "TimeIncrementUnit": "s",
    },
)
with tifffile.TiffFile(output) as tif:
    assert tif.series[0].axes == "TZYXS"
    assert tif.series[0].shape == (2, 2, 120, 160, 3)
`,
  );
  await run(independentPython, [generator], { timeout: 120_000 });
}

async function capture(name) {
  const destination = path.join(screenshotsRoot, `${name}.png`);
  const bytes = await page.screenshot({ path: destination });
  assert.ok(bytes.length > 2_000, `${name} did not capture substantive UI evidence.`);
  captures[name] = {
    file: path.relative(runRoot, destination),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
  }
}

async function waitForFile(file, action, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 0) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await noUiError(action);
    await page.waitForTimeout(100);
  }
  throw new Error(`${action}: timed out waiting for ${file}`);
}

async function launch(userData) {
  const instance = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [desktopRoot]), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const window = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1320, height: 900 });
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await window.locator("main.image-first-empty, main.research-workbench").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return { instance, window };
}

async function installDialogsAndDownload() {
  await app.evaluate(
    ({ dialog, session }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options?.title === "Add microscopy or medical images") {
          return { canceled: false, filePaths: [values.fixture] };
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
        return { canceled: true, filePath: undefined };
      };
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      session.defaultSession.on("will-download", (_event, item) => {
        if (item.getFilename().endsWith("-transects.csv")) {
          item.setSavePath(values.csv);
          item.once("done", (_doneEvent, state) => {
            globalThis.__lociQaTransectDownload = { filename: item.getFilename(), state };
          });
        }
      });
    },
    { fixture: fixturePath, study: studyPath, csv: csvPath },
  );
}

async function closeApp() {
  if (!app) return;
  const closing = app;
  await closing.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = closing.waitForEvent("close", { timeout: 30_000 });
  await closing.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await closed;
  app = undefined;
  page = undefined;
}

async function workerSnapshot() {
  return page.evaluate(() => window.lociResearch.getSnapshot());
}

async function waitForSource() {
  await page.locator(".research-source-item").waitFor({ state: "visible", timeout: 120_000 });
  let snapshot;
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    snapshot = await workerSnapshot();
    if (snapshot?.sources.length === 1) break;
    await noUiError("importing the synthetic epidermis source");
    await page.waitForTimeout(100);
  }
  assert.equal(snapshot?.sources.length, 1, "The imported source must be present in the worker snapshot.");
  const source = snapshot.sources[0];
  const viewer = page.locator(`[data-viewer-source="${source.id}"]`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    (id) => {
      const element = document.querySelector(`[data-viewer-source="${CSS.escape(id)}"]`);
      return element && Number(element.getAttribute("data-cache-bytes")) > 0 &&
        !element.querySelector(".image-view-loading");
    },
    source.id,
    { timeout: 120_000 },
  );
  await noUiError("loading the synthetic epidermis source");
  return { snapshot, source, viewer };
}

async function setRange(label, value) {
  const slider = page.getByRole("slider", { name: label, exact: true });
  await slider.evaluate((element, next) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("The native range value setter is unavailable.");
    setter.call(element, String(next));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (Number(await slider.inputValue()) === value) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} did not retain ${value}.`);
}

async function selectEpidermisTool() {
  await page.getByRole("navigation", { name: "Task groups" })
    .getByRole("button", { name: "Annotate", exact: true }).click();
  await page.getByRole("combobox", { name: "Annotate tool", exact: true }).click();
  await page.getByRole("listbox", { name: "Annotate tool", exact: true })
    .getByRole("option", { name: "Epidermal thickness", exact: true }).click();
  await page.getByRole("heading", { name: "Epidermal thickness", exact: true }).waitFor();
  await page.getByRole("button", { name: "Epidermal Transect", exact: true }).waitFor();
}

async function annotationReceipt(sourceId) {
  return page.evaluate(
    (id) => window.lociResearch.execute("source_annotations", { source_id: id }),
    sourceId,
  );
}

async function waitForAnnotationCount(sourceId, count) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const receipt = await annotationReceipt(sourceId);
    if (receipt.annotations.length === count) return receipt;
    await noUiError("saving epidermal transect history");
    await page.waitForTimeout(100);
  }
  throw new Error(`Annotation history did not reach ${count} saved transects.`);
}

async function fillProtocol(protocol) {
  await page.getByLabel("Upper boundary", { exact: true }).fill(protocol.upper_boundary);
  await page.getByLabel("Lower boundary", { exact: true }).fill(protocol.lower_boundary);
  await page.getByLabel("Orientation rule", { exact: true }).fill(protocol.orientation_rule);
  await page.getByLabel("Exclusion criteria", { exact: true }).fill(protocol.exclusions);
  await page.getByLabel("Transect reviewer", { exact: true }).fill(protocol.reviewer);
  await page.getByLabel("Annotation label", { exact: true }).fill(protocol.label);
}

async function clickSourcePoint(viewer, sourcePoint) {
  const geometry = await viewer.evaluate((element, point) => {
    const camera = JSON.parse(element.getAttribute("data-camera"));
    const viewport = element.getBoundingClientRect();
    const canvas = element.querySelector('canvas[aria-label="Source image and bound annotations"]');
    const canvasBounds = canvas.getBoundingClientRect();
    const aspectY = 0.8 / 0.5;
    const screen = {
      x: viewport.left + viewport.width / 2 + (point.x - camera.x) * camera.scale,
      y: viewport.top + viewport.height / 2 + (point.y - camera.y) * camera.scale * aspectY,
    };
    const hit = document.elementFromPoint(screen.x, screen.y);
    return {
      camera,
      viewport: { left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height },
      canvas: { left: canvasBounds.left, top: canvasBounds.top, right: canvasBounds.right, bottom: canvasBounds.bottom },
      aspect_y: aspectY,
      screen,
      hit_is_canvas: hit === canvas,
      hit_target: hit instanceof Element
        ? `${hit.tagName.toLowerCase()}${hit.className ? `.${String(hit.className).replaceAll(" ", ".")}` : ""}`
        : null,
    };
  }, sourcePoint);
  assert.ok(
    geometry.screen.x >= geometry.canvas.left && geometry.screen.x <= geometry.canvas.right &&
      geometry.screen.y >= geometry.canvas.top && geometry.screen.y <= geometry.canvas.bottom,
    `Source point ${JSON.stringify(sourcePoint)} did not map inside the real canvas.`,
  );
  assert.equal(
    geometry.hit_is_canvas,
    true,
    `Source point ${JSON.stringify(sourcePoint)} was obstructed by ${geometry.hit_target}.`,
  );
  await page.mouse.click(geometry.screen.x, geometry.screen.y, { button: "left" });
  return geometry;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  assert.equal(quoted, false, "CSV ended inside a quoted field.");
  assert.equal(row.length, 0, "CSV did not end at a row boundary.");
  return rows;
}

function assertSavedAnnotation(annotation, source) {
  assert.equal(annotation.kind, "line");
  assert.equal(annotation.z, 1);
  assert.equal(annotation.t, 1);
  assert.equal(annotation.unit, "um"); // Native source geometry canonicalizes micrometres.
  assert.ok(Math.abs(annotation.length - 40) < 1e-6,
    `Expected calibrated 40 µm transect, received ${annotation.length} ${annotation.unit}.`);
  assert.ok(Math.abs(annotation.points[0].x - 40) < 0.05);
  assert.ok(Math.abs(annotation.points[0].y - 20) < 0.05);
  assert.ok(Math.abs(annotation.points[1].x - 40) < 0.05);
  assert.ok(Math.abs(annotation.points[1].y - 70) < 0.05);
  assert.deepEqual(annotation.transect, {
    schema: "loci.epidermal-transect/v1",
    class: savedProtocol.class,
    upper_boundary: savedProtocol.upper_boundary,
    lower_boundary: savedProtocol.lower_boundary,
    orientation_rule: savedProtocol.orientation_rule,
    exclusions: savedProtocol.exclusions,
    review: { status: "approved", reviewer: savedProtocol.reviewer },
  });
  assert.equal(source.sha256, fixtureIdentity.sha256);
}

try {
  await Promise.all([
    fs.mkdir(screenshotsRoot, { recursive: true }),
    fs.mkdir(fixtureRoot, { recursive: true }),
    fs.mkdir(initialUserData, { recursive: true }),
    fs.mkdir(reopenUserData, { recursive: true }),
    fs.access(executablePath),
    fs.access(workerPath),
    fs.access(mainArtifact),
    fs.access(independentPython),
  ]);
  await generateFixture();

  const git = async (...args) =>
    (await run("git", args, { cwd: projectRoot })).stdout.trim();
  sourceIdentity = {
    head: await git("rev-parse", "HEAD"),
    head_tree: await git("rev-parse", "HEAD^{tree}"),
    status: await git("status", "--porcelain"),
    harness_sha256: await sha256(import.meta.filename),
    workbench_sha256: await sha256(
      path.join(desktopRoot, "src", "renderer", "ResearchWorkbench.tsx"),
    ),
    annotation_panel_sha256: await sha256(
      path.join(desktopRoot, "src", "renderer", "SourceAnnotationPanel.tsx"),
    ),
    annotation_engine_sha256: await sha256(
      path.join(projectRoot, "engine", "src", "loci_engine", "source_annotations.py"),
    ),
  };
  buildIdentity = {
    mode: packaged ? "packaged" : "development",
    app_path: packagedApp,
    executable_path: executablePath,
    executable_sha256: await sha256(executablePath),
    main_artifact_path: mainArtifact,
    main_artifact_sha256: await sha256(mainArtifact),
    worker_path: workerPath,
    worker_sha256: await sha256(workerPath),
    worker_command: packaged
      ? { executable: workerPath, args: [] }
      : { executable: workerPath, args: ["-m", "loci_engine.worker"] },
  };
  fixtureIdentity = {
    path: fixturePath,
    sha256: await sha256(fixturePath),
    axes: "TZYXS",
    dimensions_tzyxs: [2, 2, 120, 160, 3],
    physical_calibration: { x: 0.5, y: 0.8, z: 2.0, unit: "µm" },
    synthetic_non_biological: true,
    contains_protected_data: false,
  };

  ({ instance: app, window: page } = await launch(initialUserData));
  await installDialogsAndDownload();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const opened = await waitForSource();
  assert.equal(opened.source.name, path.basename(fixturePath));
  assert.equal(opened.source.sha256, fixtureIdentity.sha256);
  assert.deepEqual(opened.source.metadata.dimensions, {
    t: 2, c: 1, z: 2, y: 120, x: 160, s: 3,
  });
  assert.equal(opened.source.metadata.sample_semantics, "RGB");
  assert.deepEqual(opened.source.metadata.physical_calibration, {
    axes: "ZYX",
    spacing: [2, 0.8, 0.5],
    unit: "µm",
  });

  await setRange("Z plane", 1);
  await setRange("Time frame", 1);
  await page.waitForTimeout(100);
  await noUiError("selecting Z/T plane");
  await selectEpidermisTool();
  await page.getByLabel("Transect class", { exact: true }).selectOption(savedProtocol.class);
  await fillProtocol(savedProtocol);

  const firstPointGeometry = await clickSourcePoint(opened.viewer, { x: 40, y: 20 });
  await page.getByText("1 / 2 endpoints placed.", { exact: false }).waitFor();
  const secondPointGeometry = await clickSourcePoint(opened.viewer, { x: 40, y: 70 });
  await page.getByText("2 / 2 endpoints placed.", { exact: false }).waitFor();
  await page.getByLabel("Confirm transect review", { exact: true }).check();
  await page.getByRole("button", { name: "Save annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor({ timeout: 120_000 });
  const savedReceipt = await waitForAnnotationCount(opened.source.id, 1);
  const savedAnnotation = savedReceipt.annotations[0];
  assertSavedAnnotation(savedAnnotation, opened.source);
  await page.getByText(/40 um.*Approved by QA Reviewer/).waitFor();
  await capture("01-approved-calibrated-transect");

  await page.getByLabel("Transect class", { exact: true }).selectOption("ridge-base");
  await fillProtocol(unsavedProtocol);
  await page.getByRole("button", { name: "Export transects CSV", exact: true }).click();
  let download;
  const downloadDeadline = performance.now() + 30_000;
  while (performance.now() < downloadDeadline) {
    download = await app.evaluate(() => globalThis.__lociQaTransectDownload);
    if (download) break;
    await page.waitForTimeout(100);
  }
  assert.equal(download?.state, "completed", "The Electron CSV download must complete.");
  assert.match(download.filename, /-transects\.csv$/);
  await waitForFile(csvPath, "exporting transect CSV");
  const csvText = await fs.readFile(csvPath, "utf8");
  const csvRows = parseCsv(csvText);
  assert.equal(csvRows.length, 2);
  const csvRecord = Object.fromEntries(csvRows[0].map((name, index) => [name, csvRows[1][index]]));
  assert.equal(csvRecord.source_id, opened.source.id);
  assert.equal(csvRecord.source_sha256, opened.source.sha256);
  assert.equal(csvRecord.class, savedProtocol.class);
  assert.equal(csvRecord.upper_boundary, savedProtocol.upper_boundary);
  assert.equal(csvRecord.lower_boundary, savedProtocol.lower_boundary);
  assert.equal(csvRecord.orientation_rule, savedProtocol.orientation_rule);
  assert.equal(csvRecord.exclusions, savedProtocol.exclusions);
  assert.equal(csvRecord.review_status, "approved");
  assert.equal(csvRecord.reviewer, savedProtocol.reviewer);
  assert.equal(csvRecord.label, `[transect:${savedProtocol.class}] ${savedProtocol.label}`);
  assert.equal(csvRecord.z, "1");
  assert.equal(csvRecord.t, "1");
  assert.equal(csvRecord.coordinate_space, "level0-pixel-edges");
  assert.equal(csvRecord.unit, "um");
  assert.ok(Math.abs(Number(csvRecord.length) - 40) < 1e-6);
  for (const value of Object.values(unsavedProtocol)) {
    assert.equal(csvText.includes(value), false,
      `CSV leaked the current unsaved form value: ${value}`);
  }
  await capture("02-saved-protocol-csv-exported");

  await page.getByRole("button", { name: "Undo annotation", exact: true }).click();
  await page.getByText("0 saved", { exact: true }).waitFor({ timeout: 120_000 });
  const undone = await waitForAnnotationCount(opened.source.id, 0);
  assert.equal(undone.can_redo, true);
  await page.getByRole("button", { name: "Redo annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor({ timeout: 120_000 });
  const redone = await waitForAnnotationCount(opened.source.id, 1);
  assert.deepEqual(redone.annotations[0], savedAnnotation,
    "Undo/redo changed the stored transect metadata or calibrated geometry.");
  await capture("03-redone-saved-metadata");

  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await waitForFile(path.join(studyPath, "study.sqlite3"), "Save as study");
  await page.waitForFunction(
    () => !document.querySelector("main.research-workbench")?.hasAttribute("inert"),
    undefined,
    { timeout: 120_000 },
  );
  await noUiError("Save as study");
  assert.equal(await page.locator("main.research-workbench").getAttribute("inert"), null,
    "The workspace remained locked after Save as study.");
  await capture("04-saved-as-study");
  journey = {
    source: { id: opened.source.id, sha256: opened.source.sha256, name: opened.source.name },
    plane: { z: 1, t: 1 },
    pointer_mapping: {
      first: firstPointGeometry,
      second: secondPointGeometry,
      formula: "viewport_center + (source - camera_center) * scale; Y additionally multiplied by 0.8 / 0.5",
    },
    annotation: savedAnnotation,
    history: {
      saved_revision: savedReceipt.revision,
      undone_revision: undone.revision,
      redone_revision: redone.revision,
    },
    csv: {
      path: csvPath,
      sha256: await sha256(csvPath),
      saved_row: csvRecord,
      unsaved_form_excluded: true,
      electron_download_intercepted: true,
    },
  };
  await closeApp();

  ({ instance: app, window: page } = await launch(reopenUserData));
  await installDialogsAndDownload();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await waitForSource();
  assert.equal(reopened.source.id, opened.source.id);
  assert.equal(reopened.source.sha256, fixtureIdentity.sha256);
  const reopenedReceipt = await waitForAnnotationCount(reopened.source.id, 1);
  assert.deepEqual(reopenedReceipt.annotations[0], savedAnnotation,
    "Save as and explicit reopen changed the transect protocol or measurement.");
  assertSavedAnnotation(reopenedReceipt.annotations[0], reopened.source);
  await selectEpidermisTool();
  await page.getByText(/40 um.*Approved by QA Reviewer/).waitFor();
  await capture("05-explicit-reopen");
  journey.reopen = {
    source_id: reopened.source.id,
    source_sha256: reopened.source.sha256,
    annotation: reopenedReceipt.annotations[0],
    study_database_sha256: await sha256(path.join(studyPath, "study.sqlite3")),
  };

  assert.deepEqual(pageErrors, [], "The renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors.");
  const finalBuildIdentity = {
    executable_sha256: await sha256(executablePath),
    main_artifact_sha256: await sha256(mainArtifact),
    worker_sha256: await sha256(workerPath),
  };
  assert.deepEqual(finalBuildIdentity, {
    executable_sha256: buildIdentity.executable_sha256,
    main_artifact_sha256: buildIdentity.main_artifact_sha256,
    worker_sha256: buildIdentity.worker_sha256,
  }, "The application or worker changed during qualification.");
  assert.equal(await sha256(fixturePath), fixtureIdentity.sha256,
    "The synthetic source changed during qualification.");

  const receipt = {
    schema: packaged
      ? "loci.epidermis-workflow-packaged-qa/v1"
      : "loci.epidermis-workflow-development-qa/v1",
    status: "passed",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    invocation: packaged
      ? `LOCI_PACKAGED_APP=${packagedApp} node tests/epidermis-workflow.qa.mjs`
      : "LOCI_QA_DEV=1 node tests/epidermis-workflow.qa.mjs",
    source: sourceIdentity,
    build: buildIdentity,
    fixture: fixtureIdentity,
    assertions: {
      real_canvas_pointer_clicks_recovered_exact_source_points: true,
      calibrated_anisotropic_length_was_40_um: true,
      approval_required_and_retained_named_reviewer: true,
      csv_used_saved_protocol_not_current_form_and_included_z_t: true,
      undo_redo_retained_protocol_and_geometry: true,
      save_as_and_explicit_reopen_retained_metadata: true,
      source_bytes_and_fingerprint_unchanged: true,
    },
    journey,
    screenshots: captures,
    renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  };
  await closeApp();
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${receiptPath}\n`);
} catch (error) {
  let failureScreenshot;
  if (page) {
    try {
      await capture("99-failure");
      failureScreenshot = captures["99-failure"];
    } catch {}
  }
  let closeError;
  try {
    await closeApp();
  } catch (caught) {
    closeError = caught instanceof Error ? caught.message : String(caught);
  }
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(failurePath, `${JSON.stringify({
    schema: "loci.epidermis-workflow-qa-failure/v1",
    status: "failed",
    started_at: startedAt,
    failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    close_error: closeError,
    source: sourceIdentity,
    build: buildIdentity,
    fixture: fixtureIdentity,
    journey,
    screenshot: failureScreenshot,
    renderer: { page_errors: pageErrors, console_errors: consoleErrors },
  }, null, 2)}\n`);
  throw error;
}
