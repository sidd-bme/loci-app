import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { selectResultSection, fileMenuAction, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";

// Mutations use real visible controls and native picker interception only.
// Read-only APIs and an independent rectangle oracle verify their consequences.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
const outputRoot = process.env.LOCI_QA_OUTPUT_ROOT;
assert.equal(process.platform, "darwin");
assert.ok(bundle && path.isAbsolute(bundle), "LOCI_PACKAGED_APP must identify the rebuilt candidate");
assert.ok(outputRoot && path.isAbsolute(outputRoot), "LOCI_QA_OUTPUT_ROOT must be an explicit evidence directory");
const output = path.join(outputRoot, `first-study-${new Date().toISOString().replaceAll(":", "-")}`);
const userData = path.join(output, "user-data");
const saved = path.join(output, "saved-example.loci-study");
const exported = path.join(output, "reviewed-correction");
const archive = path.join(output, "portable-example.zip");
const imported = path.join(output, "imported-example.loci-study");
const exact = path.join(output, "exact-source.ome.tiff");
const mismatch = path.join(output, "mismatch-source.ome.tiff");
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(root, "engine/.venv/bin/python");
const executablePath = path.join(bundle, "Contents/MacOS/Loci");
const report = { status: "running", started_at: new Date().toISOString(), checks: {}, errors: [], requests: [] };
let app, page, pickerSource = mismatch;
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(path.join(output, "screenshots"));
async function sha(file) { const hash = createHash("sha256"); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest("hex"); }
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
// Snapshot insertion order differs from the persisted result listing. Compare
// every complete record by durable identity while retaining duplicates/counts.
const resultRecords = (value) => [...value.results].sort((a, b) => a.id.localeCompare(b.id));
const inspect = (id) => page.evaluate((result_id) => window.lociResearch.execute("result", { result_id }), id);
async function until(read, accept, label, allowAlert = false) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!allowAlert) {
      const alerts = page.locator('.research-alert[role="alert"]');
      if (await alerts.count()) throw new Error(`${label}: ${await alerts.first().textContent()}`);
    }
    const value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function pickers() {
  await app.evaluate(({ dialog }, values) => {
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const destinations = {
        "Save research study as": values.saved,
        "Export reviewed result bundle": values.exported,
        "Export portable study with derived results": values.archive,
        "Choose a new study directory": values.imported,
      };
      if (!(title in destinations)) throw new Error(`Unexpected first-study save dialog: ${title}`);
      return { canceled: false, filePath: destinations[title] };
    };
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const sources = {
        "Open research study": values.saved,
        "Import portable Loci study": values.archive,
        "Relink an exact local copy of the source": values.pickerSource,
      };
      if (!(title in sources)) throw new Error(`Unexpected first-study open dialog: ${title}`);
      return { canceled: false, filePaths: [sources[title]] };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { saved, exported, archive, imported, pickerSource });
}
async function launch() {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") report.errors.push(message.text()); });
  page.on("request", (request) => { if (/^https?:/.test(request.url())) report.requests.push(request.url()); });
  await page.locator("main.image-first-empty,main.image-first-workbench").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1100, 780); window.show(); window.focus(); app.focus({ steal: true }); });
  await pickers();
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = undefined;
}
async function shot(name) { await page.screenshot({ path: path.join(output, "screenshots", name + ".png") }); }
async function viewerReady() {
  await page.waitForFunction(() => Number(document.querySelector(".image-viewport")?.getAttribute("data-cache-bytes")) > 0 && !document.querySelector(".image-view-loading"));
}
async function renderedExample() {
  // Read the real painted canvas at known interior source coordinates. Tile-cache
  // readiness alone does not prove that low uint16 values are actually visible.
  return until(() => page.evaluate(() => {
    const viewport = document.querySelector(".image-viewport");
    const canvas = viewport?.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.clientWidth) return null;
    const camera = JSON.parse(viewport.getAttribute("data-camera"));
    const ratioX = canvas.width / canvas.clientWidth, ratioY = canvas.height / canvas.clientHeight;
    const context = canvas.getContext("2d");
    if (!context || !camera) return null;
    return [[10, 10], [42, 40], [144, 92], [72, 176]].map(([x, y]) => {
      const px = Math.floor(canvas.width / 2 + (x - camera.x) * camera.scale * ratioX);
      const py = Math.floor(canvas.height / 2 + (y - camera.y) * camera.scale * ratioY);
      return Array.from(context.getImageData(px, py, 1, 1).data);
    });
  }), (pixels) => pixels && pixels.every((rgba) => rgba[0] === rgba[1] && rgba[1] === rgba[2] && rgba[3] === 255) &&
    pixels[0][0] < 16 && pixels[1][0] >= 80 && pixels[1][0] <= 160 &&
    pixels[2][0] >= 170 && pixels[2][0] <= 220 && pixels[3][0] >= 240,
  "authored source visibly rendered at display range 0..200");
}
function oracle(rows, labels = [1, 2, 3]) {
  const pixels = [320, 768, 512], areas = [80, 192, 128], intensities = [100, 150, 200];
  const yx = [[39.5, 41.5], [91.5, 143.5], [175.5, 71.5]];
  const xyz = [[20.75, 19.75, 0], [71.75, 45.75, 0], [35.75, 87.75, 0]];
  assert.deepEqual(rows.map((row) => row.label), labels);
  for (const row of rows) {
    const index = row.label - 1;
    assert.equal(row.voxel_count, pixels[index]);
    assert.equal(row.measure, areas[index]);
    assert.equal(row.measure_unit, "um^2");
    assert.equal(row.index_axes, "YX");
    assert.deepEqual(row.centroid_index, yx[index]);
    assert.deepEqual(row.centroid_world_xyz, xyz[index]);
    const intensity = Object.values(row.intensity);
    assert.equal(intensity.length, 1);
    assert.equal(intensity[0].mean, intensities[index]);
    assert.equal(intensity[0].sum, intensities[index] * pixels[index]);
  }
}
try {
  const dirty = (await run("git", ["diff", "--name-only", "HEAD", "--", "desktop/src", "engine/src"], { cwd: root })).stdout.trim();
  assert.equal(dirty, "", "Commit runtime sources before packaged qualification");
  report.source = {
    commit: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    desktop_tree: (await run("git", ["rev-parse", "HEAD:desktop/src"], { cwd: root })).stdout.trim(),
    engine_tree: (await run("git", ["rev-parse", "HEAD:engine/src"], { cwd: root })).stdout.trim(),
    harness_sha256: await sha(import.meta.filename),
    app_asar_sha256: await sha(path.join(bundle, "Contents/Resources/app.asar")),
    worker_sha256: await sha(path.join(bundle, "Contents/Resources/loci-engine/loci-engine")),
  };
  await launch();
  await shot("01-welcome");
  await page.getByRole("button", { name: "Try a synthetic example", exact: true }).click();
  const created = await until(snapshot, (value) => value?.sources.length === 1, "source-only example");
  assert.equal(created.results.length, 0);
  assert.equal(created.jobs.length, 0);
  const source = created.sources[0];
  assert.equal(source.name, "synthetic-shapes-v1.ome.tiff");
  assert.equal(created.project.first_study.source_sha256, source.sha256);
  await viewerReady();
  report.checks.initial_display_pixels_rgba = await renderedExample();
  const practiceGuide = page.locator(".first-study-guide");
  if (!(await practiceGuide.evaluate(element => element.open))) await practiceGuide.locator(":scope > summary").click();
  await shot("02-practice-guide");
  await practiceGuide.locator(":scope > summary").click();
  const directories = (await fs.readdir(path.join(userData, "sessions"))).filter((name) => name.endsWith(".loci-study.source"));
  assert.equal(directories.length, 1);
  const sourcePath = path.join(userData, "sessions", directories[0], source.name);
  assert.equal(await sha(sourcePath), source.sha256);
  const bytes = await fs.readFile(sourcePath);
  await fs.writeFile(exact, bytes);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  await fs.writeFile(mismatch, changed);
  report.fixture = { name: source.name, sha256: source.sha256, size_bytes: bytes.length, provenance: JSON.parse(await fs.readFile(path.join(path.dirname(sourcePath), "provenance.json"), "utf8")) };
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of Object.entries({ X: 0, Y: 0, Width: 256, Height: 256, C: 0, Z: 0, T: 0 })) await setSelectionField(page, label, value);
  await selectWorkbenchTool(page, "Analyze");
  await page.getByRole("button", { name: "Whole image", exact: true }).click();
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("classical");
  await page.getByLabel("Segmentation method", { exact: true }).selectOption("components");
  await page.getByLabel("Threshold", { exact: true }).fill("50");
  await page.getByLabel("Object foreground", { exact: true }).selectOption("bright");
  await page.getByLabel("Minimum object measure", { exact: true }).fill("1");
  await page.getByRole("checkbox", { name: "Exclude border objects" }).uncheck();
  await page.getByRole("button", { name: "Run recipe", exact: true }).click();
  const analyzed = await until(snapshot, (value) => value?.results.length === 1, "three-object result");
  const parent = analyzed.results[0];
  assert.equal(parent.object_count, 3);
  assert.ok(!parent.review || parent.review.disposition !== "reviewed");
  const parentRecord = await inspect(parent.id);
  oracle(parentRecord.measurements);
  await shot("03-three-objects");
  await selectWorkbenchTool(page, "Correction");
  await until(() => page.getByLabel("Correction label", { exact: true }).isEnabled(), Boolean, "correction readiness");
  await page.getByLabel("Correction label", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  const corrected = (await until(snapshot, (value) => value.results.length === 2, "deliberate correction")).results.find((result) => result.parent_id === parent.id);
  assert.equal(corrected.object_count, 2);
  oracle((await inspect(corrected.id)).measurements, [2, 3]);
  await page.locator(`button[data-result-id="${corrected.id}"][aria-pressed="true"]`).waitFor();
  await page.getByRole("button", { name: "Undo revision", exact: true }).click();
  await page.locator(`button[data-result-id="${parent.id}"][aria-pressed="true"]`).waitFor();
  await page.getByRole("button", { name: "Redo revision", exact: true }).click();
  await page.locator(`button[data-result-id="${corrected.id}"][aria-pressed="true"]`).waitFor();
  await selectWorkbenchTool(page, "Info");
  await selectResultSection(page, "Export");
  assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), false);
  await selectResultSection(page, "Review"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await until(snapshot, (value) => value.results.find((result) => result.id === corrected.id)?.review?.disposition === "reviewed", "visible human-only review control");
  await selectResultSection(page, "Export"); await page.getByRole("button", { name: "Export result", exact: true }).click();
  await until(() => fs.stat(path.join(exported, "manifest.json")).catch(() => null), (value) => value?.isFile(), "atomic reviewed export");
  const resultJson = JSON.parse(await fs.readFile(path.join(exported, "result.json"), "utf8"));
  assert.equal(resultJson.result.revision_hash, corrected.revision_hash);
  assert.equal(resultJson.review.disposition, "reviewed");
  assert.equal(resultJson.source.sha256, source.sha256);
  const manifest = JSON.parse(await fs.readFile(path.join(exported, "manifest.json"), "utf8"));
  for (const member of manifest.files) { assert.equal(path.basename(member.name), member.name); assert.equal(await sha(path.join(exported, member.name)), member.sha256); }
  // Independent full-array oracle, never the segmentation implementation.
  report.checks.full_arrays = JSON.parse((await run(python, ["-c", `import json,sys,numpy as np,tifffile
raw=tifffile.imread(sys.argv[1]); labels=np.load(sys.argv[2],allow_pickle=False)
expected=np.zeros((256,256),np.uint16); expected[32:48,32:52]=100; expected[80:104,128:160]=150; expected[160:192,64:80]=200
np.testing.assert_array_equal(raw,expected)
corrected=np.zeros((256,256),np.uint32); corrected[80:104,128:160]=2; corrected[160:192,64:80]=3
np.testing.assert_array_equal(labels,corrected)
print(json.dumps({'raw_exact':True,'corrected_labels_exact':True,'shape':[256,256]}))`, sourcePath, path.join(exported, "labels.npy")])).stdout);
  await fileMenuAction(page, "Save as study…");
  await until(() => page.locator(".session-save-state").textContent(), (text) => text === "Saved locally", "Save As completion");
  const beforeClose = await snapshot();
  await page.locator(`button[data-result-id="${corrected.id}"]`).click();
  await page.locator(`button[data-result-id="${corrected.id}"][aria-pressed="true"]`).waitFor();
  await selectWorkbenchTool(page, "Info");
  assert.equal(beforeClose.results.find((result) => result.id === corrected.id).review.disposition, "reviewed");
  await selectResultSection(page, "Export");
  await until(() => page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), Boolean, "selected reviewed revision after Save As");
  report.checks.saved_capture = { selected_result_id: corrected.id, revision_hash: corrected.revision_hash, review: "reviewed" };
  await shot("04-reviewed-saved");
  await close(); await launch();
  await fileMenuAction(page, "Open study");
  const reopened = await until(snapshot, (value) => value?.results.length === 2, "cold saved reopen");
  assert.deepEqual(reopened.sources, beforeClose.sources);
  assert.deepEqual(resultRecords(reopened), resultRecords(beforeClose));
  oracle((await inspect(parent.id)).measurements);
  oracle((await inspect(corrected.id)).measurements, [2, 3]);
  await viewerReady();
  report.checks.reopened_display_pixels_rgba = await renderedExample();
  // Discard the original managed session through its visible recovery control;
  // the separately saved study and app-owned raw source must still reopen.
  await fileMenuAction(page, "Recent work");
  await page.locator("main.image-first-empty").waitFor();
  await page.getByRole("button", { name: "Discard Synthetic shapes practice", exact: true }).click();
  assert.equal(await sha(sourcePath), source.sha256);
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const afterDiscard = await until(snapshot, (value) => value?.results.length === 2, "saved reopen after managed discard");
  assert.deepEqual(resultRecords(afterDiscard), resultRecords(reopened));
  await viewerReady();
  await selectWorkbenchTool(page, "Portability");
  await page.getByRole("button", { name: "Export portable study", exact: true }).click();
  await until(() => fs.stat(archive).catch(() => null), (value) => value?.isFile(), "portable archive");
  await page.getByRole("button", { name: "Import portable study", exact: true }).click();
  const unavailable = await until(snapshot, (value) => value.sources[0].locator_state === "relink-required", "portable source unavailable");
  assert.deepEqual(resultRecords(unavailable), resultRecords(reopened));
  await selectWorkbenchTool(page, "Display");
  const recovery = page.locator(".image-view-unavailable").getByRole("button", { name: "Relink exact source", exact: true });
  await recovery.click();
  await page.locator('.research-alert[role="alert"]').waitFor();
  assert.match(await page.locator('.research-alert[role="alert"]').textContent(), /match|fingerprint|size/i);
  const rejected = await snapshot();
  assert.equal(rejected.sources[0].locator_state, "relink-required");
  assert.deepEqual(resultRecords(rejected), resultRecords(unavailable));
  await shot("05-mismatched-source");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  pickerSource = exact; await pickers();
  await recovery.click();
  const relinked = await until(snapshot, (value) => value.sources[0].locator_state !== "relink-required", "exact relink");
  assert.equal(relinked.sources[0].id, source.id);
  assert.equal(relinked.sources[0].sha256, source.sha256);
  assert.deepEqual(resultRecords(relinked), resultRecords(unavailable));
  await viewerReady();
  assert.equal(await sha(sourcePath), source.sha256);
  await shot("06-exact-source-restored");
  report.checks.workflow = { source_only: true, parent_id: parent.id, corrected_id: corrected.id, exact_measurements: true, undo_redo: true, review_via_visible_control: true, atomic_export: true, save_as_cold_reopen: true, reopen_after_managed_discard: true, mismatch_retains_review: true, exact_relink_preserves_results: true, original_bytes_unchanged: true };
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requests, [], "The example must work without network traffic");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack ?? String(error);
  if (page) await shot("failure").catch(() => undefined);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, "qa-report.json"), JSON.stringify(report, null, 2));
  await close();
  console.log(JSON.stringify({ status: report.status, receipt: path.join(output, "qa-report.json") }));
}
