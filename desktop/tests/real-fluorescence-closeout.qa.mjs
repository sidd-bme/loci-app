/** Scripted packaged GUI closeout on eight explicitly granted development fields.
 * Dialog responses are injected. This is automated renderer QA, not ordinary
 * native computer use, human scientific review, or accuracy qualification.
 * No references, held-out inputs, downloads, or hidden scientific RPC mutations.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectResultSection, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile), root = path.resolve(import.meta.dirname, "../..");
const requiredPath = name => { const value = process.env[name]; assert.ok(value && path.isAbsolute(value), `${name} must be explicit and absolute`); return path.resolve(value); };
assert.equal(process.platform, "darwin");
const inputPath = requiredPath("LOCI_QA_FLUORESCENCE_INPUT_MANIFEST");
const appBundle = await fs.realpath(requiredPath("LOCI_PACKAGED_APP"));
const outputParent = requiredPath("LOCI_QA_OUTPUT_ROOT");
const startedAt = new Date().toISOString();
const runRoot = path.join(outputParent, "real-fluorescence-closeout-" + startedAt.replaceAll(/[:.]/g, "-"));
const studyPath = path.join(runRoot, "SIMULATED automated development GUI review.loci-study");
const recordsPath = path.join(runRoot, "inspected-records.json");
const executable = path.join(appBundle, "Contents/MacOS/Loci");
const asar = path.join(appBundle, "Contents/Resources/app.asar");
const worker = path.join(appBundle, "Contents/Resources/loci-engine/loci-engine");
const settings = { image_mode: "fluorescence", polarity: "bright", expected_diameter_px: 32, min_area_px: 80,
  sensitivity: 0, smoothing_px: 1, split_touching: true, exclude_border: false };
const workingBytes = 512 * 1024 ** 2;
const defaultCandidate = {
  source_commit: "71c94e342efb6e20bf3eaeb4568fcf7566e1795c",
  executable_sha256: "12225f99ea0b24e8f0c6e704a7937887bd8e131cda96c18f690a617d713cf441",
  asar_sha256: "851bcb09ad2d059aec8cb6df975bcba52a327af04ea7269f241504db9ed7df66",
  worker_sha256: "e8133c7fb961bb49db242a3e84e5d4ec679e2c5592ad8479f0050b104caa99ba",
};
const expectedCandidate = process.env.LOCI_QA_CANDIDATE_IDENTITY
  ? JSON.parse(await fs.readFile(requiredPath("LOCI_QA_CANDIDATE_IDENTITY"), "utf8")) : defaultCandidate;
assert.match(expectedCandidate.source_commit, /^[a-f0-9]{40}$/);
for (const name of ["executable_sha256", "asar_sha256", "worker_sha256"]) assert.match(expectedCandidate[name], /^[a-f0-9]{64}$/);
const correctionKey = process.env.LOCI_QA_CORRECTION_SOURCE_KEY;
const correctionRequested = ["LOCI_QA_CORRECTION_SOURCE_KEY", "LOCI_QA_CORRECTION_X", "LOCI_QA_CORRECTION_Y"].some(name => process.env[name] !== undefined);
let correctionPoint;
if (correctionRequested) {
  assert.ok(correctionKey, "Correction requires an explicit source key selected after image inspection");
  correctionPoint = { x: Number(process.env.LOCI_QA_CORRECTION_X), y: Number(process.env.LOCI_QA_CORRECTION_Y) };
  for (const coordinate of Object.values(correctionPoint)) assert.ok(Number.isSafeInteger(coordinate) && coordinate >= 0, "Correction coordinates are zero-based native integer pixel indices");
}
const report = { schema: "loci.real-fluorescence-closeout-scripted-gui/v1", status: "running", started_at: startedAt,
  app_bundle: appBundle, output_root: runRoot, study_path: studyPath, records_path: recordsPath,
  expected_candidate: expectedCandidate, settings, working_bytes: workingBytes,
  method: "Automated packaged renderer controls with injected native-dialog responses; not ordinary native computer use",
  review: "SIMULATED automated GUI review transitions; original interface actor values retained, no human scientific approval",
  limitation: "Development-only engineering journey. Independent raw array/measurement evaluation is separate. No accuracy qualification or image-guided correction correctness is inferred.",
  automatic: [], correction: null, captures: [], dialogs: [], page_errors: [], console_errors: [], network_requests: [] };
let app, page, exportDestination, session = 0;
let records = { automatic: {}, correction: null };
async function hash(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
async function identity() { return { executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker) }; }
const git = async (...args) => (await run("git", args, { cwd: root, maxBuffer: 4 * 1024 ** 2 })).stdout.trim();
async function studyFiles(directory, prefix = "") {
  const files = [];
  for (const entry of (await fs.readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name), file = path.join(directory, relative);
    assert.ok(!entry.isSymbolicLink(), "Saved study must not contain symlinks");
    if (entry.isDirectory()) files.push(...await studyFiles(directory, relative));
    else { assert.ok(entry.isFile()); files.push({ name: relative, size_bytes: (await fs.stat(file)).size, sha256: await hash(file) }); }
  }
  return files;
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
async function noError(label) {
  for (const alert of await page.locator('.research-alert[role=alert], .adaptive-panel [role=alert], .research-correction [role=alert]').all())
    if (await alert.isVisible()) throw new Error(label + ": " + await alert.innerText());
}
async function wait(read, predicate, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await noError(label);
    const state = await snapshot();
    const failed = state?.jobs?.find(job => ["failed", "interrupted", "cancelled"].includes(job.state));
    if (failed) throw new Error(`${label}: durable ${failed.operation} ${failed.state}: ${failed.error}`);
    const value = await read();
    if (value != null && predicate(value)) return value;
    await page.waitForTimeout(150);
  }
  throw new Error("No verified completion for " + label);
}
async function inspect(id) {
  const read = offset => page.evaluate(request => window.lociResearch.execute("result", request), { result_id: id, offset, limit: 1000 });
  const first = await read(0);
  assert.ok(Number.isSafeInteger(first.total_rows) && first.total_rows >= 0 && first.total_rows <= 10_000, "Bounded full-field object table");
  const measurements = [...first.measurements];
  while (measurements.length < first.total_rows) {
    const next = await read(measurements.length);
    assert.equal(next.result.revision_hash, first.result.revision_hash); assert.equal(next.total_rows, first.total_rows);
    assert.ok(next.measurements.length > 0); measurements.push(...next.measurements);
  }
  assert.equal(measurements.length, first.total_rows);
  return { ...first, measurements };
}
async function capture(name, locator) {
  const file = path.join(runRoot, name + ".png");
  if (locator) await locator.screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  const record = { name, file, sha256: await hash(file), at: new Date().toISOString() };
  report.captures.push(record); process.stdout.write("Capture: " + file + "\n"); return record;
}
async function dialogs(sources = []) {
  await app.evaluate(({ dialog }, values) => {
    globalThis.lociFluorescenceCloseoutDialogs ??= [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const filePaths = title === "Add microscopy or medical images" ? values.sources : title === "Open research study" ? [values.study] : null;
      if (!filePaths?.length) throw new Error("Unexpected scripted GUI open dialog: " + title);
      globalThis.lociFluorescenceCloseoutDialogs.push({ title, file_names: filePaths.map(file => file.split(/[\\/]/).at(-1)) });
      return { canceled: false, filePaths };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const filePath = title === "Save research study as" ? values.study : title === "Export reviewed result bundle" ? values.export : null;
      if (!filePath) throw new Error("Unexpected scripted GUI save dialog: " + title);
      globalThis.lociFluorescenceCloseoutDialogs.push({ title, file_name: filePath.split(/[\\/]/).at(-1) });
      return { canceled: false, filePath };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources, study: studyPath, export: exportDestination });
}
async function launch(sources = []) {
  const userData = path.join(runRoot, "user-data-" + ++session); await fs.mkdir(userData);
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData], cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.page_errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.console_errors.push(message.text()); });
  page.on("request", request => { if (/^https?:/.test(request.url())) report.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }));
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); } app.hide();
  });
  await dialogs(sources); await page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 60_000 });
}
async function close() {
  if (!app) return;
  report.dialogs.push(...await app.evaluate(() => globalThis.lociFluorescenceCloseoutDialogs ?? []));
  const closing = app, done = closing.waitForEvent("close", { timeout: 30_000 });
  await closing.evaluate(({ app }) => app.quit()); await done; app = undefined; page = undefined;
}
async function selectSource(source) {
  const row = page.locator(`button[data-source-id="${source.id}"]`);
  if (await row.getAttribute("aria-current") !== "true") await row.click();
  await wait(() => row.getAttribute("aria-current"), value => value === "true", "activate explicitly selected development source");
}
async function selectResult(result) {
  const row = page.locator(`button[data-result-id="${result.id}"]`);
  if (!(await row.getAttribute("class"))?.includes("selected")) await row.click();
  await wait(() => row.getAttribute("class"), value => value?.includes("selected"), "select exact result revision");
}
async function exportNative(record, directory) {
  await selectResult(record.result); await selectWorkbenchTool(page, "Info"); await selectResultSection(page, "Export");
  if (record.result.review === null) {
    assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), false);
    await selectResultSection(page, "Review"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await wait(snapshot, state => state.results.find(item => item.id === record.result.id)?.review?.disposition === "reviewed", "SIMULATED automated review gate");
  }
  exportDestination = directory; await dialogs(); await selectResultSection(page, "Export");
  assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Export result", exact: true }).click();
  const manifest = await wait(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, Boolean, "new atomic native export");
  const reviewed = await inspect(record.result.id);
  assert.equal(manifest.schema, "loci.export-manifest/v1"); assert.equal(manifest.result_id, reviewed.result.id); assert.equal(manifest.revision_hash, reviewed.result.revision_hash);
  assert.ok(manifest.files.some(file => file.name === "labels.npy")); assert.ok(manifest.files.some(file => file.name === "objects.csv"));
  for (const entry of manifest.files) {
    assert.equal(path.basename(entry.name), entry.name, "Native manifest names must remain contained");
    const file = path.join(directory, entry.name); assert.ok(!(await fs.lstat(file)).isSymbolicLink());
    assert.equal(await hash(file), entry.sha256); assert.equal((await fs.stat(file)).size, entry.size_bytes);
  }
  const native = JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8"));
  assert.equal(native.result.id, reviewed.result.id); assert.equal(native.result.revision_hash, reviewed.result.revision_hash);
  assert.deepEqual(native.result.arrays, reviewed.result.arrays);
  assert.deepEqual(native.result.provenance, { ...reviewed.provenance, measurements: reviewed.measurements });
  assert.deepEqual(native.review, reviewed.result.review);
  return { record: reviewed, export: { directory, manifest_sha256: await hash(path.join(directory, "manifest.json")), files: manifest.files } };
}
async function frozenControls(source) {
  assert.equal(source.source_kind, "native");
  assert.ok(!["RGB", "RGBA"].includes(source.metadata.sample_semantics));
  await selectSource(source); await selectWorkbenchTool(page, "Display");
  const dimensions = source.metadata.dimensions;
  assert.equal(dimensions.c, 1); assert.equal(dimensions.s, 1); assert.equal(dimensions.z, 1); assert.equal(dimensions.t, 1);
  for (const [label, value] of [["X", 0], ["Y", 0], ["Width", dimensions.x], ["Height", dimensions.y], ["C", 0], ["Z", 0], ["T", 0]]) await setSelectionField(page, label, value);
  await wait(() => page.locator(`[data-viewer-source="${source.id}"]`).getAttribute("data-prepared"), value => value === "true", "complete native source plane prepared");
  await selectWorkbenchTool(page, "Analyze"); await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  const panel = page.locator(".adaptive-panel");
  await panel.getByLabel("Segmentation input", { exact: true }).selectOption("0");
  await panel.getByLabel("Imaging preset", { exact: true }).selectOption(settings.image_mode);
  await panel.getByLabel("Cell polarity", { exact: true }).selectOption(settings.polarity);
  for (const [key, label] of [["expected_diameter_px", "Expected diameter"], ["min_area_px", "Minimum cell area"], ["sensitivity", "Sensitivity"], ["smoothing_px", "Edge smoothing"]]) {
    const field = panel.getByLabel(label, { exact: true }); await field.fill(String(settings[key])); await field.press("Enter"); assert.equal(await field.getAttribute("aria-invalid"), "false");
  }
  await panel.getByLabel("Split touching cells", { exact: true }).setChecked(true);
  await panel.getByLabel("Exclude border cells", { exact: true }).setChecked(false);
  await panel.getByLabel("Adaptive memory allowance", { exact: true }).selectOption(String(workingBytes));
  return panel;
}
async function captureLabels(entry, prefix) {
  await selectResult(entry.result); await selectWorkbenchTool(page, "Population");
  const viewer = page.locator(`[data-viewer-source="${entry.source.id}"]`);
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
  await wait(() => viewer.getAttribute("data-result-overlay"), value => value === entry.result.id + ":" + entry.result.revision_hash, "exact result revision bound to visible source overlay");
  await wait(() => viewer.getAttribute("data-prepared"), value => value === "true", "label overlay on prepared exact source");
  const view = await page.evaluate(request => window.lociResearch.execute("result_view", request, { viewer_lane: "qa-inspection" }), { result_id: entry.result.id, axis: "z", index: 0, labels: true });
  assert.equal(view.result_id, entry.result.id); assert.equal(view.revision_hash, entry.result.revision_hash);
  assert.deepEqual(view.shape, entry.result.arrays.labels.shape);
  const screenshot = await capture(prefix + "-labels", viewer);
  // Keep an additional explicitly labelled read-only runtime grid rendering for
  // native-coordinate inspection. This is not a computer-use screenshot.
  assert.ok(view.image.startsWith("data:image/png;base64,"));
  const gridFile = path.join(runRoot, prefix + "-read-only-native-result-grid.png");
  await fs.writeFile(gridFile, Buffer.from(view.image.split(",")[1], "base64"));
  return { screenshot, native_grid: { file: gridFile, sha256: await hash(gridFile), meaning: "Read-only result_view rendering, native YX grid; not a UI screenshot" },
    source_dimensions: entry.source.metadata.dimensions, camera: JSON.parse(await viewer.getAttribute("data-camera")), coordinate_convention: "zero-based native source X/Y pixel-center indices" };
}
async function applyCorrection(entry) {
  await selectSource(entry.source); await selectResult(entry.result); await selectWorkbenchTool(page, "Population");
  const dimensions = entry.source.metadata.dimensions;
  assert.ok(correctionPoint.x < dimensions.x && correctionPoint.y < dimensions.y);
  const binding = { result_id: entry.result.id, revision_hash: entry.result.revision_hash, axis: "z", index: 0, u: correctionPoint.x, v: correctionPoint.y };
  const picked = await page.evaluate(request => window.lociResearch.execute("result_label_at", request), binding);
  assert.equal(picked.result_id, entry.result.id); assert.equal(picked.revision_hash, entry.result.revision_hash); assert.ok(picked.label > 0, "Lead-chosen coordinate must actually lie on a positive label");
  const viewer = page.locator(`[data-viewer-source="${entry.source.id}"]`);
  await wait(() => viewer.getAttribute("data-prepared"), value => value === "true", "source/result canvas ready for actual object selection");
  const calibration = entry.source.metadata.physical_calibration?.spacing;
  const affine = entry.source.metadata.geometry?.affine;
  const sx = affine ? Math.hypot(...affine.slice(0, 3).map(row => row[0])) : calibration?.at(-1);
  const sy = affine ? Math.hypot(...affine.slice(0, 3).map(row => row[1])) : calibration?.at(-2);
  const aspectY = sx && sy && sx > 0 && sy > 0 ? sy / sx : 1;
  const mapping = await viewer.evaluate((element, { point, aspectY }) => {
    const camera = JSON.parse(element.getAttribute("data-camera")), box = element.getBoundingClientRect();
    const x = box.left + box.width / 2 + (point.x + .5 - camera.x) * camera.scale;
    const y = box.top + box.height / 2 + (point.y + .5 - camera.y) * camera.scale * aspectY;
    return { x, y, camera, aspectY, box: { x: box.x, y: box.y, width: box.width, height: box.height },
      inside: x >= box.left && y >= box.top && x < box.right && y < box.bottom,
      hits_viewer: !!document.elementFromPoint(x, y)?.closest(`[data-viewer-source="${element.getAttribute("data-viewer-source")}"]`) };
  }, { point: correctionPoint, aspectY });
  assert.ok(mapping.inside && mapping.hits_viewer, "The chosen native coordinate must be visible and unobscured");
  await page.mouse.click(mapping.x, mapping.y);
  const population = page.getByRole("region", { name: "Object population explorer", exact: true });
  await population.getByLabel("Selected population object").getByRole("heading", { name: `Object #${picked.label}`, exact: true }).waitFor();
  await capture("correction-01-lead-chosen-object-selected");
  await population.getByRole("button", { name: "Edit selected object", exact: true }).click();
  await wait(() => page.getByLabel("Correction label", { exact: true }).inputValue(), value => value === String(picked.label), "actual selected object transferred to visible correction UI");
  const oldIds = new Set((await snapshot()).results.map(item => item.id));
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  const changed = await wait(snapshot, state => state.results.some(result => !oldIds.has(result.id)), "immutable corrected child");
  const children = changed.results.filter(result => !oldIds.has(result.id)); assert.equal(children.length, 1);
  const child = children[0]; assert.equal(child.parent_id, entry.result.id); assert.equal(child.object_count, entry.result.object_count - 1); assert.equal(child.review, null);
  const record = await inspect(child.id); assert.equal(record.measurements.some(row => row.label === picked.label), false);
  const withoutNeighborhoodDistance = row => { const { nearest_centroid_distance: _distance, ...stable } = row; return stable; };
  assert.deepEqual(record.measurements.map(withoutNeighborhoodDistance), entry.record.measurements.filter(row => row.label !== picked.label).map(withoutNeighborhoodDistance), "Deleting one label preserves other raw intensities/geometry/IDs; nearest-neighbor distances are recomputed");
  assert.deepEqual(await inspect(entry.result.id), entry.record, "Correction must not alter the automatic parent");
  const exported = await exportNative(record, path.join(runRoot, "corrected-" + entry.source_key));
  records.correction = exported.record;
  const result = { source_key: entry.source_key, source: entry.source, automatic_parent: entry.result, result: exported.record.result,
    export: exported.export, native_coordinate: correctionPoint, selected_label: picked.label, pointer_mapping: mapping,
    interpretation: "Lead-supplied image-inspection coordinate; scripted delete/review/export exercised. No claim that deletion improves biological correctness." };
  result.labels = await captureLabels(result, "correction-02"); return result;
}

await fs.mkdir(runRoot, { recursive: true });
let inputs, originalStudyFiles;
try {
  report.build = await identity();
  for (const [key, value] of Object.entries(report.build)) assert.equal(value, expectedCandidate[key], "Candidate identity mismatch: " + key);
  report.source = { head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"), status: await git("status", "--porcelain"),
    harness_sha256: await hash(import.meta.filename), helper_sha256: await hash(path.join(import.meta.dirname, "workbench-qa-helpers.mjs")) };
  const manifest = JSON.parse(await fs.readFile(inputPath, "utf8"));
  assert.equal(manifest.count, manifest.sources?.length); assert.equal(manifest.count, 12, "Expected explicit existing GUI grant manifest");
  inputs = manifest.sources.filter(record => record.dataset === "BBBC039"); assert.equal(inputs.length, 8);
  const unique = new Set();
  for (const input of inputs) {
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.ok(path.isAbsolute(input.original_adapter) && path.isAbsolute(input.gui_copy));
    const segments = input.original_adapter.split(/[\\/]/);
    assert.ok(segments.includes("BBBC039") && segments.includes("development"), "Only explicitly granted BBBC039 development paths may be imported");
    assert.ok(!segments.some(part => /^(held[-_]?out|sealed(?:-test)?|test|testing|validation)$/i.test(part)), "Reject held-out source paths");
    assert.equal(input.well, null); assert.match(input.purpose, /development images/);
    input.import_path = await fs.realpath(input.original_adapter);
    const actualSegments = input.import_path.split(/[\\/]/);
    assert.ok(actualSegments.includes("BBBC039") && actualSegments.includes("development"));
    assert.ok(!actualSegments.some(part => /^(held[-_]?out|sealed(?:-test)?|test|testing|validation)$/i.test(part)));
    assert.equal(await hash(input.import_path), input.sha256); assert.equal(await hash(input.gui_copy), input.sha256);
    input.source_key = path.basename(input.import_path).replace(/\.ome\.tiff?$/i, "");
    assert.ok(!unique.has(input.source_key)); unique.add(input.source_key);
  }
  if (correctionRequested) assert.ok(inputs.some(input => input.source_key === correctionKey), "Correction key must name one of these eight development sources");
  report.input_manifest = { path: inputPath, sha256: await hash(inputPath), structural_schema: "existing unversioned {count,sources}; only BBBC039 development records selected", selected: inputs };
  const resumePath = process.env.LOCI_QA_FLUORESCENCE_RESUME_RECEIPT;
  if (resumePath) {
    assert.ok(correctionRequested, "Resume is correction-only and requires a lead-chosen source and coordinate");
    const priorPath = requiredPath("LOCI_QA_FLUORESCENCE_RESUME_RECEIPT"), prior = JSON.parse(await fs.readFile(priorPath, "utf8"));
    assert.equal(prior.schema, report.schema); assert.equal(prior.status, "passed"); assert.equal(prior.correction, null);
    assert.deepEqual(prior.build, report.build); assert.equal(prior.expected_candidate.source_commit, expectedCandidate.source_commit);
    assert.equal(path.dirname(prior.study_path), path.dirname(priorPath), "Resume study must be owned by its prior receipt directory");
    assert.equal(path.dirname(prior.records_path), path.dirname(priorPath), "Resume records must be owned by their prior receipt directory");
    assert.equal(prior.input_manifest.sha256, report.input_manifest.sha256); assert.equal(prior.automatic.length, 8);
    assert.equal(await hash(prior.records_path), prior.records_sha256);
    originalStudyFiles = await studyFiles(prior.study_path); assert.deepEqual(originalStudyFiles, prior.saved_study_files);
    await fs.cp(prior.study_path, studyPath, { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual(await studyFiles(studyPath), originalStudyFiles);
    records = JSON.parse(await fs.readFile(prior.records_path, "utf8")); assert.equal(records.correction, null);
    report.automatic = prior.automatic; report.resume = { receipt: priorPath, sha256: await hash(priorPath), original_study: prior.study_path, original_study_files: originalStudyFiles };
    await launch(); await page.getByRole("button", { name: "Open study", exact: true }).click();
    await wait(snapshot, state => state.results.length === 8 && state.sources.length === 8, "cold open copied exact eight-result study");
    for (const entry of report.automatic) {
      assert.ok(inputs.some(input => input.source_key === entry.source_key && input.sha256 === entry.source.sha256));
      entry.record = records.automatic[entry.source_key];
      assert.deepEqual(await inspect(entry.result.id), entry.record, "Resume preserves exact automatic scientific record");
    }
  } else {
    await launch(inputs.map(input => input.import_path));
    await page.getByRole("button", { name: "Open images", exact: true }).click();
    await page.getByRole("main", { name: "Research workspace", exact: true }).waitFor();
    const initial = await wait(snapshot, state => state.sources.length === 8, "visible import of eight explicit development sources");
    assert.equal(initial.results.length, 0);
    for (const [index, input] of inputs.entries()) {
      const source = initial.sources.find(source => source.sha256 === input.sha256 && source.name === path.basename(input.import_path)); assert.ok(source);
      const panel = await frozenControls(source);
      const prefix = String(index + 1).padStart(2, "0") + "-" + input.source_key;
      const settingsCapture = await capture(prefix + "-settings");
      const ids = new Set((await snapshot()).results.map(result => result.id));
      await panel.getByRole("button", { name: "Segment image", exact: true }).click();
      const state = await wait(snapshot, state => state.results.some(result => !ids.has(result.id)), "frozen diameter32 adaptive result");
      const added = state.results.filter(result => !ids.has(result.id)); assert.equal(added.length, 1);
      const record = await inspect(added[0].id), result = record.result;
      assert.equal(result.kind, "adaptive-segmentation"); assert.equal(result.source_id, source.id); assert.equal(result.source_sha256, input.sha256); assert.equal(result.review, null);
      const selection = { x: 0, y: 0, width: source.metadata.dimensions.x, height: source.metadata.dimensions.y, c: 0, z: 0, t: 0, level: 0 };
      assert.deepEqual(record.provenance.selection, selection); assert.deepEqual(record.provenance.settings, settings); assert.deepEqual(record.provenance.measurement_channels, [0]);
      assert.equal(record.provenance.measurement_basis, "raw-selected-channel-values-on-result-grid");
      assert.equal(record.provenance.accepted_request.working_bytes, workingBytes);
      assert.equal(record.total_rows, result.object_count);
      assert.deepEqual(result.arrays.labels.shape, [selection.height, selection.width]);
      for (const row of record.measurements) {
        assert.ok(Number.isSafeInteger(row.voxel_count) && row.voxel_count > 0);
        assert.deepEqual(Object.keys(row.intensity), ["source_channel_0"]);
        for (const value of Object.values(row.intensity.source_channel_0)) assert.ok(Number.isFinite(value));
      }
      const done = await wait(snapshot, state => state.jobs.some(job => job.id === record.provenance.job_id && job.state === "succeeded"), "durable adaptive completion");
      const job = done.jobs.find(job => job.id === record.provenance.job_id);
      assert.equal(job.operation, "classical_run"); assert.equal(job.error, null); assert.deepEqual(job.result_ids, [result.id]);
      assert.deepEqual(job.request, { source_id: source.id, task_request: { source_id: source.id, selection, profile_id: "loci-classical", settings, measurement_channels: [0], working_bytes: workingBytes } });
      const entry = { source_key: input.source_key, source, result, record, durable_job: job, settings_capture: settingsCapture };
      entry.labels = await captureLabels(entry, prefix);
      const exported = await exportNative(record, path.join(runRoot, "automatic-" + input.source_key));
      entry.record = exported.record; entry.result = exported.record.result; entry.export = exported.export;
      records.automatic[input.source_key] = exported.record; report.automatic.push(entry);
    }
  }
  if (correctionRequested) report.correction = await applyCorrection(report.automatic.find(entry => entry.source_key === correctionKey));
  await fileMenuAction(page, "Save study");
  await wait(() => fs.stat(path.join(studyPath, "study.sqlite3")).catch(error => { if (error.code === "ENOENT") return null; throw error; }), stat => stat?.size > 0, "saved native study");
  records.snapshot = await snapshot(); await capture("all-results-saved-SIMULATED-automated-reviews"); await close();
  await launch(); await page.getByRole("button", { name: "Open study", exact: true }).click();
  const expectedCount = correctionRequested ? 9 : 8;
  const cold = await wait(snapshot, state => state.results.length === expectedCount && state.sources.length === 8, "fresh-profile cold reopen all exact records");
  for (const result of records.snapshot.results) assert.deepEqual(cold.results.find(candidate => candidate.id === result.id), result);
  for (const entry of report.automatic) assert.deepEqual(await inspect(entry.result.id), records.automatic[entry.source_key], "Cold reopen automatic arrays/provenance/raw rows/review receipt");
  if (report.correction) assert.deepEqual(await inspect(report.correction.result.id), records.correction, "Cold reopen corrected child and review");
  for (const job of records.snapshot.jobs) assert.deepEqual(cold.jobs.find(candidate => candidate.id === job.id), job);
  await capture("cold-reopen-complete"); await close();
  for (const input of inputs) { assert.equal(await hash(input.import_path), input.sha256); assert.equal(await hash(input.gui_copy), input.sha256); }
  assert.equal(await hash(inputPath), report.input_manifest.sha256); assert.deepEqual(await identity(), report.build);
  assert.equal(await hash(import.meta.filename), report.source.harness_sha256);
  if (report.resume) {
    assert.deepEqual(await studyFiles(report.resume.original_study), originalStudyFiles, "Correction resume must preserve original study bytes");
    assert.equal(await hash(report.resume.receipt), report.resume.sha256);
  }
  for (const entry of [...report.automatic, ...(report.correction ? [report.correction] : [])]) {
    assert.equal(await hash(path.join(entry.export.directory, "manifest.json")), entry.export.manifest_sha256);
    for (const file of entry.export.files) {
      assert.equal(path.basename(file.name), file.name);
      assert.equal(await hash(path.join(entry.export.directory, file.name)), file.sha256, "Published automatic/corrected exports remain immutable");
    }
  }
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2) + "\n");
  report.records_sha256 = await hash(recordsPath); report.saved_study_files = await studyFiles(studyPath);
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); assert.deepEqual(report.network_requests, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = { name: error.name, message: error.message, stack: error.stack, stdout: error.stdout ?? null, stderr: error.stderr ?? null };
  if (page) {
    await capture("failure").catch(() => {});
    await fs.writeFile(path.join(runRoot, "failure-ui.txt"), await page.locator("body").innerText().catch(() => "UI unavailable"));
    await fs.writeFile(path.join(runRoot, "failure-snapshot.json"), JSON.stringify(await snapshot().catch(() => null), null, 2));
  }
  throw error;
} finally {
  if (app) await close().catch(error => { report.close_error = String(error); report.status = "failed"; process.exitCode = 1; });
  report.finished_at = new Date().toISOString();
  const receipt = path.join(runRoot, "real-fluorescence-closeout-receipt.json");
  await fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n"); process.stdout.write(JSON.stringify({ status: report.status, receipt }) + "\n");
}
