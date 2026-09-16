import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";
import { verifyResearchBatchExports } from "./research-batch-qa-helpers.mjs";

// Core image-first regression. The learned model has its own pinned full-array
// journey; viewer/volume journeys add multiresolution, colour and GPU evidence.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const development = process.env.LOCI_QA_DEV === "1";
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? path.join(root, ".loci/builds/current/Loci.app"));
const source = process.env.LOCI_QA_IMAGE;
assert.equal(process.platform, "darwin");
assert.ok(source && path.isAbsolute(source), "LOCI_QA_IMAGE must identify an authorized absolute fixture");
assert.ok(!process.env.LOCI_QA_EXPECTED_PROFILE || process.env.LOCI_QA_EXPECTED_PROFILE === "loci-classical",
  "Use cellpose-workbench.qa.mjs for the pinned learned-model journey");
const expectedCount = Number(process.env.LOCI_QA_EXPECTED_COUNT ?? 36);
assert.ok(Number.isSafeInteger(expectedCount) && expectedCount > 0);
const outputRoot = process.env.LOCI_QA_OUTPUT_ROOT;
assert.ok(outputRoot && path.isAbsolute(outputRoot), "Use an explicit qualification directory outside Git");
assert.ok(path.relative(root, outputRoot).startsWith(`..${path.sep}`));
const output = path.join(outputRoot, `packaged-${new Date().toISOString().replaceAll(":", "-")}`);
const userData = path.join(output, "user-data"), project = path.join(output, "core-qualification.loci-study");
const screenshots = path.join(output, "screenshots"), folder = path.join(output, "collection");
const formulaFolder = path.join(output, "formula-collection");
const baselineExport = path.join(output, "baseline-export"), correctedExport = path.join(output, "corrected-export");
const batchExport = path.join(output, "batch-export"), summaryExport = path.join(output, "summary-export");
const executablePath = development ? path.join(root, "desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron") : path.join(appBundle, "Contents/MacOS/Loci");
const workerPath = development ? path.join(root, "engine/.venv/bin/python") : path.join(appBundle, "Contents/Resources/loci-engine/loci-engine");
const asar = development ? path.join(root, "desktop/.vite/build/main.js") : path.join(appBundle, "Contents/Resources/app.asar");
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(root, "engine/.venv/bin/python");
await fs.mkdir(output, { recursive: true });
await Promise.all([fs.mkdir(userData), fs.mkdir(screenshots), fs.mkdir(formulaFolder),
  fs.mkdir(path.join(folder, "day-1"), { recursive: true }), fs.mkdir(path.join(folder, "day-2/repeat"), { recursive: true }),
  fs.mkdir(path.join(folder, "day-2/previous_loci"), { recursive: true })]);
const sourceCopy = path.join(output, `microscopy-with-an-intentionally-long-filename-for-inspector-layout-validation${path.extname(source)}`);
const folderCopies = Array.from({ length: 10 }, (_, i) => path.join(folder, i % 2 ? "day-2/repeat" : "day-1", `field-${String(i + 1).padStart(2, "0")}${path.extname(source)}`));
const formulaCopies = ["=formula", "normal"].map((name) => path.join(formulaFolder, name + path.extname(source)));
await Promise.all([sourceCopy, ...folderCopies, ...formulaCopies].map((target) => fs.copyFile(source, target)));
await Promise.all(["overlay.png", "labels.tiff", "measurements.csv", "analysis.json"].map((name) =>
  fs.writeFile(path.join(folder, "day-2/previous_loci", `previous_${name}`), "Previous export must not be imported.")));
async function sha(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
const sourceHash = await sha(source), sourceStat = await fs.stat(source);
if (!development) {
  const notices = path.join(appBundle, "Contents/Resources/notices");
  assert.match(await fs.readFile(path.join(notices, "LOCI_LICENSE"), "utf8"), /Apache License\s+Version 2\.0/i);
  assert.match(await fs.readFile(path.join(notices, "LOCI_NOTICE"), "utf8"), /Cellpose 4\.2\.1\.1\s+runtime/);
  async function checkBundle(directory) { for (const e of await fs.readdir(directory, { withFileTypes: true })) {
    assert.ok(e.name !== ".DS_Store" && !e.name.startsWith("._"), "Finder metadata entered the app bundle");
    if (e.isDirectory()) await checkBundle(path.join(directory, e.name));
  } }
  await checkBundle(appBundle);
}
const referenceLabels = path.join(output, "reference-labels.npy");
const reference = JSON.parse((await run(python, ["-c", `
import hashlib,json,sys,numpy as np
from PIL import Image
from loci_engine.segment import segment_image
from loci_engine.models import SegmentationSettings
image=np.asarray(Image.open(sys.argv[1])); settings=SegmentationSettings(); result=segment_image(image,settings)
np.save(sys.argv[2],result.labels.astype(np.uint32),allow_pickle=False)
print(json.dumps({'shape':list(image.shape),'count':result.count,'settings':settings.to_dict(),'measurements':result.measurements,'sha256':hashlib.sha256(result.labels.astype(np.uint32).tobytes()).hexdigest()}))
`, source, referenceLabels], { cwd: path.join(root, "engine") })).stdout);
assert.equal(reference.count, expectedCount, "Pre-UI established algorithm reference changed");
assert.deepEqual(reference.shape, [1536, 1536], "This correction/batch phantom journey expects its declared source grid");
const errors = [], consoleErrors = [], requests = [], timings = {}, receipts = {};
const sourceIdentity = {
  commit: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
  desktop_source_tree: (await run("git", ["rev-parse", "HEAD:desktop/src"], { cwd: root })).stdout.trim(),
  engine_source_tree: (await run("git", ["rev-parse", "HEAD:engine/src"], { cwd: root })).stdout.trim(),
  harness_sha256: await sha(import.meta.filename),
};
const changedRuntime = (await run("git", ["diff", "--name-only", "HEAD", "--", "desktop/src", "engine/src"], { cwd: root })).stdout.trim().split("\n").filter(Boolean);
sourceIdentity.runtime_worktree_changes = Object.fromEntries(await Promise.all(changedRuntime.map(async (file) => [file, await sha(path.join(root, file))])));
assert.ok(development || changedRuntime.length === 0, "Packaged qualification requires a committed runtime source tree");
const performanceBudgets = { empty_launch_seconds: 8, first_useful_1536_square_seconds: 5 };
const rendererModules = new Map(), rendererResponses = [];
let app, page, picker = { sources: [sourceCopy], folder, export: baselineExport, rendered: path.join(output, "rendered-default.tiff") };
async function installPickers() {
  await app.evaluate(({ dialog }, values) => {
    globalThis.coreQaPicker = values;
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1), p = globalThis.coreQaPicker;
      if (options.title === "Add microscopy or medical images") return { canceled: false, filePaths: p.sources };
      if (options.title === "Open research study") return { canceled: false, filePaths: [p.project] };
      if (options.title === "Choose a destination for reviewed batch results") return { canceled: false, filePaths: [p.export] };
      if (/folder|collection/i.test(options.title ?? "")) return { canceled: false, filePaths: [p.folder] };
      throw new Error(`Unexpected qualification picker: ${options.title}`);
    };
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1), p = globalThis.coreQaPicker;
      if (options.title === "Save research study as") return { canceled: false, filePath: p.project };
      if (options.title === "Export reviewed result bundle") return { canceled: false, filePath: p.export };
      if (/rendered/i.test(options.title ?? "")) return { canceled: false, filePath: p.rendered };
      if (/batch|summary/i.test(options.title ?? "")) return { canceled: false, filePath: p.export };
      throw new Error(`Unexpected qualification save picker: ${options.title}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { ...picker, project });
}
async function launch() {
  const start = performance.now();
  app = await electron.launch({ executablePath, args: [...(development ? [path.join(root, "desktop")] : []), `--user-data-dir=${userData}`], cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  if (development) page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === "http://localhost:5173" && url.pathname.startsWith("/src/"))
      rendererResponses.push(response.body().then((bytes) => rendererModules.set(url.pathname, createHash("sha256").update(bytes).digest("hex"))).catch(() => undefined));
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("request", (r) => { if (/^https?:/.test(r.url())) {
    const url = new URL(r.url());
    if (!(development && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5173")) requests.push(r.url());
  } });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1024, 720); w.show(); w.focus(); w.moveTop(); app.focus({ steal: true }); });
  timings.launch_seconds ??= (performance.now() - start) / 1000;
  await installPickers();
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit()); await closed; app = undefined;
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const record = (id) => page.evaluate((result_id) => window.lociResearch.execute("result", { result_id }), id);
const shot = (name) => { console.log(JSON.stringify({ stage: name })); return page.screenshot({ path: path.join(screenshots, name + ".png") }); };
async function until(read, accept, label, timeout = 60_000, allowAlert = false) {
  const start = performance.now(); let value;
  while (performance.now() - start < timeout) {
    value = await read();
    const alert = page.locator('.research-alert[role="alert"]');
    const error = await alert.count() ? await alert.textContent() : null;
    if (!allowAlert && error) throw new Error(`${label}: ${error}`);
    if (accept(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: timed out: ${JSON.stringify(value)}`);
}
async function viewerReady() {
  await page.waitForFunction(() => Number(document.querySelector('.image-viewport')?.getAttribute('data-cache-bytes')) > 0 && !document.querySelector('.image-view-loading'), null, { timeout: 60_000 });
}
async function selectResult(id) {
  const current = await snapshot(), result = current.results.find((item) => item.id === id);
  assert.ok(result, "The requested result is not in this study");
  const resultSource = current.sources.find((item) => item.id === result.source_id);
  assert.ok(resultSource, "The result's source is not open");
  const sourceButton = page.locator('.research-sources > button').filter({ has: page.getByText(resultSource.name, { exact: true }) });
  if (await sourceButton.getAttribute('aria-current') !== 'true') await sourceButton.click();
  await page.locator(`[data-result-id="${id}"]`).click();
  await page.locator(`[data-result-id="${id}"][aria-pressed="true"]`).waitFor();
  await page.locator('.image-viewport[data-result-overlay]').waitFor();
}
async function latestResult() {
  const id = await page.locator('[data-result-id][aria-pressed="true"]').getAttribute("data-result-id");
  return (await snapshot()).results.find((r) => r.id === id);
}
async function changedFrom(parent, label) {
  const next = await until(async () => { const s = await snapshot(); return s.results.find((r) => r.parent_id === parent.id); },
    (r) => r?.revision_hash !== parent.revision_hash && r?.object_count !== undefined, label);
  await page.locator(`[data-result-id="${next.id}"][aria-pressed="true"]`).waitFor();
  await until(() => page.getByLabel("Correction tool", { exact: true }).isEnabled(), Boolean, label + " correction readiness");
  await viewerReady();
  await moveNavigationAway();
  return next;
}
async function reviewAndExport(result, destination) {
  await selectResult(result.id); await selectWorkbenchTool(page, "Info");
  if (!(await snapshot()).results.find((r) => r.id === result.id)?.review)
    await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await until(snapshot, (s) => s.results.find((r) => r.id === result.id)?.review?.disposition === "reviewed", "exact review");
  picker.export = destination; await installPickers();
  await page.getByRole("button", { name: "Export revision", exact: true }).click();
  await until(() => fs.stat(path.join(destination, "manifest.json")).catch(() => null), (s) => s?.isFile(), "reviewed export");
  const exported = JSON.parse(await fs.readFile(path.join(destination, "result.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
  assert.equal(exported.result.revision_hash, result.revision_hash); assert.equal(exported.review.disposition, "reviewed");
  assert.equal(exported.source.sha256, sourceHash); assert.equal("path" in exported.source, false);
  for (const item of manifest.files) { assert.equal(path.basename(item.name), item.name); assert.equal(await sha(path.join(destination, item.name)), item.sha256); }
  return exported;
}
async function imagePoint(u, v, click = true) {
  const viewport = page.locator('.image-viewport'), b = await viewport.boundingBox();
  const c = JSON.parse(await viewport.getAttribute('data-camera'));
  assert.ok(b); const point = { x: b.x + b.width / 2 + (u + 0.5 - c.x) * c.scale, y: b.y + b.height / 2 + (v + 0.5 - c.y) * c.scale };
  assert.ok(point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height, "Correction point is outside the visible source");
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
  assert.equal(hit, "CANVAS", "Correction point is obscured by UI");
  if (click) await page.mouse.click(point.x, point.y);
  return point;
}
async function moveNavigationAway() {
  const viewport = await page.locator('.image-viewport').boundingBox();
  const handle = await page.getByRole('button', { name: 'Move navigation toolbar', exact: true }).boundingBox();
  assert.ok(viewport && handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height - 60, { steps: 8 });
  await page.mouse.up();
}
async function correctionReady() {
  await selectWorkbenchTool(page, "Correction");
  await until(() => page.getByLabel("Correction tool", { exact: true }).isEnabled(), Boolean, "exact correction tools");
  await page.locator('.image-viewport').waitFor();
  await viewerReady();
  await moveNavigationAway();
}
try {
  await launch(); await shot("01-direct-opening");
  const started = performance.now(); await page.getByRole("button", { name: "Open images", exact: true }).click();
  const opened = await until(snapshot, (s) => s?.sources.length === 1, "direct source opening");
  assert.equal(opened.results.length, 0); assert.equal(opened.sources[0].sha256, sourceHash);
  await viewerReady(); timings.first_useful_view_seconds = (performance.now() - started) / 1000;
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
  await shot("02-full-image");
  await page.locator('.source-export > summary').click();
  await page.getByLabel("Rendered export format", { exact: true }).selectOption("tiff");
  await page.getByLabel("Rendered export extent", { exact: true }).selectOption("whole");
  const defaultTiff = picker.rendered;
  await page.getByRole("button", { name: "Export TIFF16…", exact: true }).click();
  await until(() => fs.stat(defaultTiff).catch(() => null), (v) => v?.isFile(), "full-resolution default TIFF16 export");
  await page.locator('.source-channel > summary').first().click();
  await page.getByLabel("Channel 1 gamma", { exact: true }).fill("2");
  await page.getByLabel("Channel 1 gamma", { exact: true }).blur();
  picker.rendered = path.join(output, "rendered-adjusted.tiff"); await installPickers();
  await page.getByRole("button", { name: "Export TIFF16…", exact: true }).click();
  await until(() => fs.stat(picker.rendered).catch(() => null), (v) => v?.isFile(), "adjusted TIFF16 export");
  receipts.rendered_tiff16 = JSON.parse((await run(python, ["-c", `import json,sys,numpy as np,tifffile
from PIL import Image
raw=np.asarray(Image.open(sys.argv[1])); a=tifffile.imread(sys.argv[2]); b=tifffile.imread(sys.argv[3]); assert a.dtype==b.dtype==np.uint16; assert a.shape==b.shape==(1536,1536,3); np.testing.assert_array_equal(a,np.repeat((raw.astype(np.uint16)*257)[...,None],3,axis=2)); assert np.any(a!=b)
print(json.dumps({'shape':list(a.shape),'dtype':str(a.dtype),'default_equals_source_codes_x257':True,'adjustment_changes_display':True}))`, source, defaultTiff, picker.rendered])).stdout);
  await page.locator('.source-channel-heading').getByRole("button", { name: "Reset", exact: true }).click();
  await fileMenuAction(page, "Save as study…");
  await until(() => fs.stat(project).catch(() => null), (s) => s?.isDirectory(), "save managed source as study");
  await until(() => page.locator('.session-save-state').textContent(), (text) => text === 'Saved locally', 'completed Save as');
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of Object.entries({ X: 0, Y: 0, Width: 1536, Height: 1536 })) await setSelectionField(page, label, value);
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  const analysisStart = performance.now(); await page.getByRole("button", { name: "Segment image", exact: true }).click();
  const segmented = await until(snapshot, (s) => s?.results.length === 1, "established adaptive segmentation", 120_000);
  timings.adaptive_seconds = (performance.now() - analysisStart) / 1000;
  const initial = segmented.results[0]; assert.equal(initial.object_count, expectedCount); assert.equal(initial.kind, "adaptive-segmentation");
  const initialRecord = await record(initial.id);
  assert.deepEqual(initialRecord.provenance.settings, reference.settings);
  assert.deepEqual(initialRecord.provenance.baseline_pixel_measurements, reference.measurements);
  await reviewAndExport(initial, baselineExport);
  const labelCheck = JSON.parse((await run(python, ["-c", `import json,sys,numpy as np,tifffile
ref=np.load(sys.argv[1],allow_pickle=False); got=np.load(sys.argv[2],allow_pickle=False); ome=tifffile.imread(sys.argv[3]); np.testing.assert_array_equal(got,ref); np.testing.assert_array_equal(ome,ref); print(json.dumps({'all_pixels_equal':True,'ome_equal':True,'shape':list(got.shape)}))`, referenceLabels, path.join(baselineExport, "labels.npy"), path.join(baselineExport, "labels.ome.tif")])).stdout);
  receipts.established_adaptive = labelCheck; await shot("03-reviewed-baseline");
  await correctionReady(); await page.getByLabel("Correction tool", { exact: true }).selectOption("add");
  await page.getByLabel("New unused label ID", { exact: true }).fill(String(expectedCount + 1));
  // The deterministic phantom has an empty margin; a new tiny polygon is a
  // manual correction, never used as evidence for the algorithm's accuracy.
  for (const [u, v] of [[70, 70], [92, 70], [92, 92], [70, 92]]) await imagePoint(u, v);
  await page.getByRole("button", { name: "Commit add polygon", exact: true }).click();
  const added = await changedFrom(initial, "manual polygon"); assert.equal(added.object_count, expectedCount + 1); assert.equal(added.review, null);
  await page.getByRole("button", { name: "Undo revision", exact: true }).click();
  await until(latestResult, (r) => r?.id === initial.id, "undo exact parent");
  await page.getByRole("button", { name: "Redo revision", exact: true }).click();
  await until(latestResult, (r) => r?.id === added.id, "redo exact child");
  await page.getByLabel("Correction label", { exact: true }).selectOption(String(expectedCount + 1));
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  const deleted = await changedFrom(added, "delete added label"); assert.equal(deleted.object_count, expectedCount);
  await page.getByLabel("Correction tool", { exact: true }).selectOption("add");
  for (const [u, v] of [[220, 40], [230, 40], [230, 50], [220, 50]]) await imagePoint(u, v);
  await page.getByRole("button", { name: "Commit add polygon", exact: true }).click();
  const seed = await changedFrom(deleted, "brush seed polygon"); assert.equal(seed.object_count, expectedCount + 1);
  await page.getByLabel("Correction label", { exact: true }).selectOption(String(expectedCount + 1));
  await page.getByLabel("Correction tool", { exact: true }).selectOption("paint");
  await page.getByLabel("Physical brush radius", { exact: true }).fill("6");
  await imagePoint(232, 45); await page.getByRole("button", { name: "Commit brush", exact: true }).click();
  const painted = await changedFrom(seed, "paint brush"); assert.equal(painted.object_count, expectedCount + 1);
  await page.getByLabel("Correction label", { exact: true }).selectOption(String(expectedCount + 1));
  await page.getByLabel("Correction tool", { exact: true }).selectOption("erase");
  await page.getByLabel("Physical brush radius", { exact: true }).fill("2");
  await imagePoint(236, 45); await page.getByRole("button", { name: "Commit brush", exact: true }).click();
  const erased = await changedFrom(painted, "erase brush"); assert.equal(erased.object_count, expectedCount + 1);
  await page.getByRole("button", { name: "Undo revision", exact: true }).click();
  await until(latestResult, (r) => r?.id === painted.id, "undo erase");
  await page.getByRole("button", { name: "Redo revision", exact: true }).click();
  await until(latestResult, (r) => r?.id === erased.id, "redo erase");
  await page.getByLabel("Correction label", { exact: true }).selectOption(String(expectedCount + 1));
  await page.getByLabel("Correction tool", { exact: true }).selectOption("vertex");
  await page.getByRole("button", { name: "Nudge selected vertex right one voxel", exact: true }).waitFor();
  const boundary = await page.evaluate(({ result_id, revision_hash, label }) => window.lociResearch.execute("correction_info", { result_id, revision_hash, label, plane: "XY", index: 0 }), { result_id: erased.id, revision_hash: erased.revision_hash, label: expectedCount + 1 });
  const vertices = boundary.boundary.vertices_uv;
  const firstVertex = vertices[0], from = await imagePoint(firstVertex.u, firstVertex.v, false), to = await imagePoint(firstVertex.u + 3, firstVertex.v, false);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
  await until(() => page.getByRole("button", { name: "Commit boundary vertex", exact: true }).isEnabled(), Boolean, "single vertex drag");
  await page.getByRole("button", { name: "Commit boundary vertex", exact: true }).click();
  const vertex = await changedFrom(erased, "boundary vertex"); assert.equal(vertex.object_count, expectedCount + 1);
  const finalRecord = await record(vertex.id); receipts.corrections = { added: added.id, deleted: deleted.id, painted: painted.id, erased: erased.id, vertex: vertex.id };
  await reviewAndExport(vertex, correctedExport); await shot("04-corrected-reviewed-result");
  const corrected = JSON.parse((await run(python, ["-c", `import json,sys,numpy as np
base=np.load(sys.argv[1],allow_pickle=False); got=np.load(sys.argv[2],allow_pickle=False); assert np.unique(got[got>0]).size==int(sys.argv[3]); assert np.any(base!=got); assert np.all(base[200:,200:]==got[200:,200:]); print(json.dumps({'changes_local_to_declared_correction_margin':True,'changed_pixels':int(np.count_nonzero(base!=got))}))`, referenceLabels, path.join(correctedExport, "labels.npy"), String(expectedCount + 1)])).stdout);
  receipts.corrections.numerical = corrected;
  const saved = await snapshot(); await close(); await launch();
  const reopened = await until(snapshot, (s) => s?.results.length === saved.results.length, "exact reviewed reopen");
  assert.deepEqual(reopened.sources, saved.sources); assert.deepEqual(reopened.results, saved.results);
  assert.deepEqual((await record(vertex.id)).provenance, finalRecord.provenance);
  await selectResult(vertex.id); await shot("05-reopened");
  const sessionBeforeRecent = await page.evaluate(() => window.lociResearch.sessionState());
  await fileMenuAction(page, 'Recent work');
  await page.locator('main.image-first-empty').waitFor();
  await page.locator('.recent-sessions').getByRole('button', { name: sessionBeforeRecent.title, exact: true }).click();
  await until(snapshot, (s) => s?.results.length === saved.results.length, 'open exact saved study from Recent work');
  const workspace = page.locator('.workspace-record-actions'); await workspace.locator('summary').click();
  await workspace.getByRole("button", { name: "Clear image results", exact: true }).click();
  await until(snapshot, (s) => s.results.length === 0 && s.workspace.hidden_results.length === saved.results.length, "durable clear");
  await workspace.getByRole("button", { name: "Undo", exact: true }).click();
  await until(snapshot, (s) => s.results.length === saved.results.length, "undo clear");
  await workspace.getByRole("button", { name: "Close image", exact: true }).click();
  await until(snapshot, (s) => s.sources.length === 0 && s.workspace.closed_sources.length === 1, "durable close");
  await workspace.getByRole("button", { name: `Reopen ${path.basename(sourceCopy)}`, exact: true }).click();
  await until(snapshot, (s) => s.sources.length === 1 && s.results.length === saved.results.length, "reopen source with history");
  receipts.close_clear_undo = true;
  picker.sources = [path.join(root, "README.md")]; await installPickers();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.locator('.research-alert[role="alert"]').waitFor();
  await page.locator('main[aria-busy="true"]').waitFor({ state: "detached" });
  assert.match(await page.locator('.research-alert[role="alert"]').innerText(), /unsupported|not a supported|could not|cannot/i);
  const wrongImport = await snapshot(); assert.equal(wrongImport.sources.length, 1); assert.equal(wrongImport.results.length, saved.results.length);
  await shot("05b-wrong-import"); await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  picker.sources = [sourceCopy]; await installPickers();
  // Batch continuation is supplied by the reviewed batch-export integration.
  // All pending requests must be durable before the first item executes.
  await fileMenuAction(page, "Open folder");
  const collection = await until(snapshot, (s) => s.sources.length === 11, "recursive collection excluding prior export");
  assert.ok(collection.sources.every((s) => s.sha256 === sourceHash));
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of Object.entries({ X: 0, Y: 0, Width: 1536, Height: 1536 })) await setSelectionField(page, label, value);
  await selectWorkbenchTool(page, "Analyze"); await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  await page.getByRole("button", { name: "Segment image", exact: true }).waitFor();
  await selectWorkbenchTool(page, "Study");
  for (const s of collection.sources) await page.getByLabel(`Include ${s.name} in batch`, { exact: true }).check();
  await page.getByRole("button", { name: "Run selected sources sequentially", exact: true }).click();
  const queued = await until(snapshot, (s) => s.jobs.filter((j) => j.request_key.startsWith("loci-batch:")).length === 11, "all batch requests persisted before execution");
  assert.ok(queued.jobs.filter((j) => j.request_key.startsWith("loci-batch:")).some((j) => j.state === "queued"));
  await page.getByRole("button", { name: "Stop batch", exact: true }).click();
  const stopped = await until(snapshot, (s) => !s.jobs.some((j) => j.state === "running") && s.jobs.some((j) => j.state === "queued"), "stop preserves pending jobs", 60_000, true);
  const cancellationAlert = page.locator('.research-alert[role="alert"]');
  if (await cancellationAlert.count()) {
    assert.match(await cancellationAlert.innerText(), /^Analysis cancelled\./);
    await cancellationAlert.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  const completedBefore = stopped.jobs.filter((j) => j.request_key.startsWith("loci-batch:") && j.state === "succeeded").map((j) => j.id);
  await close(); await launch();
  await until(snapshot, (s) => s?.sources.length === 11, "pending queue reopen");
  await selectWorkbenchTool(page, "Study"); await page.getByRole("button", { name: "Resume batch", exact: true }).click();
  const resumed = await until(snapshot, (s) => !s.jobs.some((j) => ["queued", "running"].includes(j.state)), "complete resumed items", 360_000);
  await page.getByRole("button", { name: "Stop batch", exact: true }).waitFor({ state: "hidden" });
  const retry = page.getByRole("button", { name: "Retry failed or cancelled", exact: true });
  if (resumed.jobs.some((j) => j.request_key.startsWith("loci-batch:") && ["failed", "cancelled"].includes(j.state))) {
    await retry.click();
    await until(snapshot, (s) => s.jobs.filter((j) => j.request_key.startsWith("loci-batch:") && j.state === "succeeded").length === 11, "retry explicit cancelled item", 120_000);
    await page.getByRole("button", { name: "Stop batch", exact: true }).waitFor({ state: "hidden" });
  }
  const complete = await snapshot(), batchJobs = complete.jobs.filter((j) => j.request_key.startsWith("loci-batch:") && j.state === "succeeded");
  assert.equal(batchJobs.length, 11); assert.equal(new Set(batchJobs.map((j) => j.request_hash)).size, 11);
  for (const id of completedBefore) assert.ok(batchJobs.some((j) => j.id === id));
  receipts.batch = { successful_jobs: batchJobs.map((j) => j.id), no_duplicate_completion: true, pending_survived_reopen: true };
  await shot("06-durable-batch");
  const exportedResults = batchJobs.map((j) => complete.results.find((r) => r.id === j.result_ids[0]));
  assert.ok(exportedResults.every((r) => r?.object_count === expectedCount));
  // Export every exact reviewed item; aggregate/export schema checks are shared
  // with the batch writer's own qualification helper below.
  for (const result of exportedResults) { await selectResult(result.id); await selectWorkbenchTool(page, "Info"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click(); await until(snapshot, (s) => s.results.find((r) => r.id === result.id)?.review?.disposition === "reviewed", "review each batch result"); }
  receipts.batch.reviewed_result_ids = exportedResults.map((r) => r.id);
  await selectWorkbenchTool(page, "Study");
  for (const r of (await snapshot()).results) await page.getByLabel(`Compare ${r.id}`, { exact: true }).setChecked(exportedResults.some((item) => item.id === r.id));
  await page.getByLabel("Batch export contents", { exact: true }).selectOption("bundles+summary");
  await fs.mkdir(batchExport); picker.export = batchExport; await installPickers();
  await page.getByRole("button", { name: "Export selected reviewed results", exact: true }).click();
  await until(() => fs.readdir(batchExport), (names) => names.some((n) => n.startsWith('loci_batch_manifest_')), "11 exact reviewed bundles and aggregate manifest", 120_000);
  const byName = new Map(folderCopies.map((p) => [path.basename(p), path.relative(folder, p).split(path.sep).join('/')]));
  const expected = exportedResults.map((r) => {
    const s = complete.sources.find((item) => item.id === r.source_id);
    return { sourceId: s.id, name: byName.get(s.name) ?? s.name, resultId: r.id, revisionHash: r.revision_hash };
  });
  await shot("07-reviewed-batch-export");
  picker.folder = formulaFolder; await installPickers(); await fileMenuAction(page, "Open folder");
  const formulaOpened = await until(snapshot, (s) => s.sources.length === 13, "formula-safe summary sources");
  const formulaSources = formulaOpened.sources.filter((s) => formulaCopies.some((p) => path.basename(p) === s.name));
  assert.equal(formulaSources.length, 2);
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of Object.entries({ X: 0, Y: 0, Width: 1536, Height: 1536 })) await setSelectionField(page, label, value);
  await selectWorkbenchTool(page, "Analyze"); await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  await page.getByRole("button", { name: "Segment image", exact: true }).waitFor();
  await selectWorkbenchTool(page, "Study");
  for (const s of formulaOpened.sources) await page.getByLabel(`Include ${s.name} in batch`, { exact: true }).setChecked(formulaSources.some((f) => f.id === s.id));
  const beforeIds = new Set(formulaOpened.results.map((r) => r.id));
  await page.getByRole("button", { name: "Run selected sources sequentially", exact: true }).click();
  const formulaComplete = await until(snapshot, (s) => s.results.filter((r) => !beforeIds.has(r.id)).length === 2 && !s.jobs.some((j) => j.state === 'running'), "two summary source results", 120_000);
  const formulaResults = formulaComplete.results.filter((r) => !beforeIds.has(r.id));
  assert.ok(formulaResults.every((r) => r.object_count === expectedCount));
  for (const r of formulaResults) {
    await selectResult(r.id); await selectWorkbenchTool(page, "Info"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await until(snapshot, (s) => s.results.find((item) => item.id === r.id)?.review?.disposition === 'reviewed', "review summary source");
  }
  await selectWorkbenchTool(page, "Study");
  for (const r of (await snapshot()).results) await page.getByLabel(`Compare ${r.id}`, { exact: true }).setChecked(formulaResults.some((f) => f.id === r.id));
  await page.getByLabel("Batch export contents", { exact: true }).selectOption("summary-only");
  await fs.mkdir(summaryExport); picker.export = summaryExport; await installPickers();
  await page.getByRole("button", { name: "Export selected reviewed results", exact: true }).click();
  await until(() => fs.readdir(summaryExport), (names) => names.some((n) => n.startsWith('loci_batch_manifest_')), "summary-only atomic export");
  receipts.batch.exports = await verifyResearchBatchExports({ outputRoot: batchExport, summaryOnlyRoot: summaryExport, expected, referenceLabels, python });
  const summaryManifestName = (await fs.readdir(summaryExport)).find((name) => name.startsWith('loci_batch_manifest_'));
  const summaryManifest = JSON.parse(await fs.readFile(path.join(summaryExport, summaryManifestName), 'utf8'));
  assert.deepEqual(summaryManifest.selected_results.map((r) => r.result_id).sort(), formulaResults.map((r) => r.id).sort());
  await shot("08-summary-only-export");
  await Promise.all(rendererResponses);
  await close();
  assert.equal(await sha(source), sourceHash); const afterStat = await fs.stat(source);
  assert.equal(afterStat.mtimeMs, sourceStat.mtimeMs); assert.equal(afterStat.size, sourceStat.size);
  for (const copy of [sourceCopy, ...folderCopies, ...formulaCopies]) assert.equal(await sha(copy), sourceHash);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(requests, []);
  assert.ok(timings.launch_seconds <= performanceBudgets.empty_launch_seconds,
    `Empty launch exceeded 8 s: ${timings.launch_seconds}`);
  assert.ok(timings.first_useful_view_seconds <= performanceBudgets.first_useful_1536_square_seconds,
    `First useful 1536-square view exceeded 5 s: ${timings.first_useful_view_seconds}`);
  const report = { schema: "loci.image-first-core-qualification/v1", mode: development ? "forge-development" : "packaged-adhoc", source_sha256: sourceHash,
    source_identity: sourceIdentity, performance_budgets: performanceBudgets,
    hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, total_memory_bytes: os.totalmem() },
    application_sha256: await sha(executablePath), worker_sha256: await sha(workerPath), asar_sha256: await sha(asar),
    executed_renderer_modules: Object.fromEntries(rendererModules), reference_labels_sha256: await sha(referenceLabels), expected_count: expectedCount, timings, receipts,
    renderer_errors: errors, console_errors: consoleErrors, renderer_http_requests: requests,
    meaning: "Deterministic engineering regression; manual edits are not biological validation." };
  await fs.writeFile(path.join(output, "qa-report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch (error) {
  if (page && !page.isClosed()) { await shot("failure").catch(() => undefined); await fs.writeFile(path.join(output, "failure-ui.txt"), await page.locator('body').innerText()).catch(() => undefined); }
  await fs.writeFile(path.join(output, "qa-failure.json"), JSON.stringify({ error: String(error), source_identity: sourceIdentity,
    performance_budgets: performanceBudgets, errors, consoleErrors, requests, timings, receipts }, null, 2));
  await close().catch(() => app?.close()); throw error;
}
