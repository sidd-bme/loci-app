/**
 * Packaged CARE file-opening QA on macOS and Windows x64.
 * Set absolute LOCI_QA_CARE_RAW and LOCI_QA_CARE_RESTORED to the two pinned
 * publisher-demo fixtures. For the native run, set LOCI_PACKAGED_APP to the
 * bundle/directory and LOCI_QA_OUTPUT_ROOT to a new receipts directory.
 * Optional LOCI_QA_SOURCE_COMMIT pins the embedded revision.
 * Pass --fixture-preflight to verify inputs without opening the app.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  close, dialogCalls, fileIdentity, inside, launch, plainFile, projectRoot,
  requiredPath, sha256, visible,
} from "./research-model-workbench.qa.mjs";
import { fileMenuAction, sourceRowByName, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const ADD = "Add microscopy or medical images";
const SAVE = "Save research study as";
const OPEN = "Open research study";
const DIMENSIONS = { t: 1, c: 1, z: 24, y: 96, x: 96, s: 1 };

async function fixture(variable, expected, dtype) {
  const file = requiredPath(variable);
  await plainFile(file, variable);
  const identity = await fileIdentity(file);
  assert.equal(identity.sha256, expected, `${variable} must be the pinned Planaria fixture`);
  return { file, name: path.basename(file), identity, dtype };
}

const [raw, restored] = await Promise.all([
  fixture("LOCI_QA_CARE_RAW", "5887102f004b2c68fcdab121d602b0309ad71b1cc9e966a96e4c3b3fce13b81e", "uint16"),
  fixture("LOCI_QA_CARE_RESTORED", "65ff1700f255e2e065ce538c040a9158753406b7b112b8452b820073ff5ea40a", "float32"),
]);
assert.notEqual(raw.name, restored.name, "Give the two files distinct names");
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--fixture-preflight"));
if (process.argv[2] === "--fixture-preflight") {
  console.log(JSON.stringify({ raw: raw.identity, restored: restored.identity, dimensions: DIMENSIONS }));
} else {
  await journey();
}

async function installPickers(app, opens, savePath) {
  await app.evaluate(({ dialog }, values) => {
    const calls = globalThis.__lociModelQaDialogCalls = [];
    const queue = [...values.opens];
    dialog.showOpenDialog = async (...args) => {
      const { title, properties } = args.at(-1);
      calls.push({ kind: "open", title });
      const selected = queue.shift();
      if (title !== selected?.title || !properties.includes(selected.property))
        throw new Error(`Unexpected CARE QA picker: ${title}`);
      return { canceled: false, filePaths: [selected.file] };
    };
    dialog.showSaveDialog = async (...args) => {
      const { title } = args.at(-1);
      calls.push({ kind: "save", title });
      if (title !== values.saveTitle || !values.savePath)
        throw new Error(`Unexpected CARE QA save picker: ${title}`);
      return { canceled: false, filePath: values.savePath };
    };
  }, { opens, savePath, saveTitle: SAVE });
}

async function openCare(page, welcome = false) {
  if (welcome) await page.getByRole("button", { name: "Model Zoo", exact: true }).click();
  else await fileMenuAction(page, "Model Zoo…");
  const zoo = page.getByRole("dialog", { name: "Model Zoo", exact: true });
  await zoo.locator('article[data-model-id="care-planaria-3d"] .model-zoo-card__select').click();
  await zoo.getByRole("button", { name: "Open restored volume…", exact: true }).click();
  await zoo.waitFor({ state: "hidden" });
}

function checkSource(snapshot, input) {
  const source = snapshot.sources.find(item => item.name === input.name);
  assert.ok(source, `Missing imported source ${input.name}`);
  assert.match(source.id, /^[a-f0-9]{32}$/u);
  assert.equal(source.sha256, input.identity.sha256);
  assert.equal(source.size_bytes, input.identity.size_bytes);
  assert.equal(source.source_kind, "native");
  assert.equal(source.locator_state, undefined);
  assert.equal(source.metadata.format, "OME-TIFF");
  assert.equal(source.metadata.axes, "TCZYX");
  assert.deepEqual(source.metadata.dimensions, DIMENSIONS);
  assert.deepEqual(source.metadata.channel_dtypes, [input.dtype]);
  assert.equal(source.metadata.physical_calibration, null);
  assert.equal(snapshot.results.length, 0, "Opening an external image must not create an analysis result");
  assert.equal(snapshot.jobs.length, 0, "Opening an external image must not launch inference");
  return { id: source.id, name: source.name, sha256: source.sha256, dimensions: source.metadata.dimensions, dtype: input.dtype };
}

async function painted(page, source) {
  const selector = `.image-viewport[data-viewer-source="${source.id}"][data-prepared="true"]`;
  const viewport = page.locator(selector);
  await visible(page, viewport.locator("canvas"), `source canvas for ${source.name}`, 30_000);
  const handle = await page.waitForFunction(selector => {
    const view = document.querySelector(selector);
    const canvas = view?.querySelector("canvas");
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas.clientWidth || !canvas.clientHeight || view.querySelector(".image-view-loading")) return false;
    const camera = JSON.parse(view.dataset.camera);
    const pixels = [];
    // Sample pixel centres within the source image, never the viewport backdrop.
    for (let y = 12.5; y < 96; y += 12) {
      for (let x = 12.5; x < 96; x += 12) {
        const px = Math.floor(canvas.width / 2 + (x - camera.x) * camera.scale * canvas.width / canvas.clientWidth);
        const py = Math.floor(canvas.height / 2 + (y - camera.y) * camera.scale * canvas.height / canvas.clientHeight);
        if (px < 0 || px >= canvas.width || py < 0 || py >= canvas.height) return false;
        const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
        if (a !== 255) return false;
        pixels.push((r << 16) | (g << 8) | b);
      }
    }
    return new Set(pixels).size > 2 && pixels;
  }, selector, { timeout: 30_000 });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

async function selectSource(page, source) {
  const show = page.getByRole("button", { name: "Show image list", exact: true });
  if (await show.isVisible()) await show.click();
  const row = await sourceRowByName(page, source.name);
  await row.click();
  const samples = await painted(page, source);
  assert.equal(await row.getAttribute("aria-current"), "true");
  return samples;
}

async function journey() {
  const windows = process.platform === "win32";
  assert.ok(process.platform === "darwin" || windows && process.arch === "x64", "Use a supported packaged desktop");
  const bundle = await fs.realpath(requiredPath("LOCI_PACKAGED_APP"));
  const requested = requiredPath("LOCI_QA_OUTPUT_ROOT");
  const output = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  assert.ok(!inside(bundle, output), "Keep receipts outside the application bundle");
  assert.ok(!inside(projectRoot, output) || inside(path.join(projectRoot, ".loci", "evidence"), output),
    "Use a fresh directory outside the source tree or under .loci/evidence");
  const executablePath = path.join(bundle, windows ? "Loci.exe" : "Contents/MacOS/Loci");
  const resources = path.join(bundle, windows ? "resources" : "Contents/Resources");
  const identityPath = path.join(resources, "loci-build-identity.json");
  await plainFile(executablePath, "Packaged executable", true);
  await plainFile(identityPath, "Packaged identity");
  const { sourceRevision, sourceTree, sourceDirty, buildNumber } = JSON.parse(await fs.readFile(identityPath, "utf8"));
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(sourceTree, /^[a-f0-9]{40}$/u);
  assert.equal(sourceDirty, false);
  assert.ok(Number.isSafeInteger(buildNumber) && buildNumber > 0);
  if (process.env.LOCI_QA_SOURCE_COMMIT) assert.equal(sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);

  const report = {
    status: "running", stage: "welcome",
    build: { sourceRevision, sourceTree, buildNumber, executable_sha256: await sha256(executablePath),
      app_asar_sha256: await sha256(path.join(resources, "app.asar")),
      worker_sha256: await sha256(path.join(resources, "loci-engine", windows ? "loci-engine.exe" : "loci-engine")) },
    inputs: { raw: raw.identity, restored: restored.identity },
  };
  const saved = path.join(output, "CARE.loci-study");
  const imagePicker = input => ({ title: ADD, property: "openFile", file: input.file });
  let activeApp;
  async function open(profile, picks, destination) {
    const { app, page } = await launch(path.join(output, profile), [], { executablePath });
    activeApp = app;
    page.setDefaultTimeout(30_000);
    await installPickers(app, picks, destination);
    return page;
  }
  async function quit() {
    await close(activeApp);
    activeApp = undefined;
  }

  await fs.mkdir(output, { mode: 0o700 });
  try {
    const welcome = await open("welcome-profile", [imagePicker(restored)]);
    await openCare(welcome, true);
    const first = checkSource(await waitForSnapshot(welcome, s => s?.sources.length === 1, "welcome import"), restored);
    report.welcome = { source: first, painted: await painted(welcome, first), pickers: await dialogCalls(activeApp) };
    assert.deepEqual(report.welcome.pickers, [{ kind: "open", title: ADD }]);
    await quit();

    report.stage = "open-study";
    const page = await open("study-profile", [imagePicker(raw), imagePicker(restored)], saved);
    await page.getByRole("button", { name: "Open images", exact: true }).click();
    const rawStudy = await waitForSnapshot(page, s => s?.sources.length === 1, "raw-only study");
    assert.ok(rawStudy.project.project_id);
    const rawSource = checkSource(rawStudy, raw);
    const rawPaint = await painted(page, rawSource);
    await openCare(page);
    const combined = await waitForSnapshot(page, s => s?.sources.length === 2, "raw and restored in the open study");
    assert.equal(combined.project.project_id, rawStudy.project.project_id);
    assert.deepEqual(checkSource(combined, raw), rawSource);
    const derivedSource = checkSource(combined, restored);
    assert.notEqual(rawSource.id, derivedSource.id);
    const derivedPaint = await painted(page, derivedSource);
    assert.notDeepEqual(derivedPaint, rawPaint, "The raw and restored stage samples must differ");

    report.stage = "save";
    await fileMenuAction(page, "Save study");
    await visible(page, page.getByText("Saved locally", { exact: true }), "saved CARE study", 30_000);
    await plainFile(path.join(saved, "study.sqlite3"), "Saved study database");
    report.study = { raw: rawSource, restored: derivedSource, raw_painted: rawPaint,
      restored_painted: derivedPaint, pickers: await dialogCalls(activeApp) };
    assert.deepEqual(report.study.pickers, [{ kind: "open", title: ADD }, { kind: "open", title: ADD }, { kind: "save", title: SAVE }]);
    await quit();

    report.stage = "reopen";
    const reopened = await open("reopen-profile", [{ title: OPEN, property: "openDirectory", file: saved }]);
    await reopened.getByRole("button", { name: "Open study", exact: true }).click();
    const cold = await waitForSnapshot(reopened, s => s?.sources.length === 2, "cold study sources");
    assert.deepEqual(checkSource(cold, raw), rawSource);
    assert.deepEqual(checkSource(cold, restored), derivedSource);
    const reopenedRaw = await selectSource(reopened, rawSource);
    const reopenedRestored = await selectSource(reopened, derivedSource);
    assert.notDeepEqual(reopenedRaw, reopenedRestored);
    report.reopen = { raw_painted: reopenedRaw, restored_painted: reopenedRestored, pickers: await dialogCalls(activeApp) };
    assert.deepEqual(report.reopen.pickers, [{ kind: "open", title: OPEN }]);
    await quit();
    assert.deepEqual(await fileIdentity(raw.file), raw.identity);
    assert.deepEqual(await fileIdentity(restored.file), restored.identity);
    report.stage = "complete";
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message.split("\n")[0];
    for (const localPath of [bundle, output, raw.file, restored.file])
      report.error = report.error.replaceAll(localPath, "<local>");
    console.error(`CARE QA failed during ${report.stage}: ${report.error}`);
    process.exitCode = 1;
  } finally {
    if (activeApp) await activeApp.close().catch(() => {});
    await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
}
