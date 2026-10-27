/** Synthetic packaged perinuclear regression. Run in the lead's serial window.
 * Scientific mutations use visible controls; RPCs only read assertion evidence.
 * The GUI review transition is SIMULATED automation, never human approval.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectResultSection, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const startedAt = new Date().toISOString();
assert.equal(process.platform, "darwin", "This packaged journey requires macOS");
assert.ok(process.env.LOCI_PACKAGED_APP && path.isAbsolute(process.env.LOCI_PACKAGED_APP), "Select an explicit absolute LOCI_PACKAGED_APP");
const appBundle = await fs.realpath(process.env.LOCI_PACKAGED_APP);
const executable = path.join(appBundle, "Contents/MacOS/Loci");
const asar = path.join(appBundle, "Contents/Resources/app.asar");
const worker = path.join(appBundle, "Contents/Resources/loci-engine/loci-engine");
const python = process.env.LOCI_QA_PYTHON ?? path.join(root, "engine/.venv/bin/python");
const oracleScript = path.join(root, "scripts/fixtures/perinuclear_qa.py");
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(root, ".loci/qa"), "perinuclear-" + startedAt.replaceAll(/[:.]/g, "-"));
const fixtureRoot = path.join(runRoot, "synthetic-fixture");
const sourcePath = path.join(fixtureRoot, "synthetic-dna-and-signal.ome.tiff");
const studyPath = path.join(runRoot, "SIMULATED automated perinuclear QA.loci-study");
const recordsPath = path.join(runRoot, "inspected-records.json");
const exports = [path.join(runRoot, "before-cold-reopen"), path.join(runRoot, "after-cold-reopen")];
const workingBytes = 512 * 1024 ** 2;
const control = "SIMULATED automated synthetic software QA; C0 is a declared DNA proxy and C1 is an artificial raw signal. Five-pixel rings are geometric proxies, not cytoplasm. No human scientific approval or biological validation.";
// Default is the already packaged public build 6. Future candidates require an
// explicit expectation file, never inference from a bundle name or version.
const defaultCandidate = {
  source_commit: "71c94e342efb6e20bf3eaeb4568fcf7566e1795c",
  executable_sha256: "12225f99ea0b24e8f0c6e704a7937887bd8e131cda96c18f690a617d713cf441",
  asar_sha256: "851bcb09ad2d059aec8cb6df975bcba52a327af04ea7269f241504db9ed7df66",
  worker_sha256: "e8133c7fb961bb49db242a3e84e5d4ec679e2c5592ad8479f0050b104caa99ba",
};
const expectedCandidate = process.env.LOCI_QA_CANDIDATE_IDENTITY
  ? JSON.parse(await fs.readFile(process.env.LOCI_QA_CANDIDATE_IDENTITY, "utf8")) : defaultCandidate;
assert.match(expectedCandidate.source_commit, /^[a-f0-9]{40}$/);
for (const key of ["executable_sha256", "asar_sha256", "worker_sha256"]) assert.match(expectedCandidate[key], /^[a-f0-9]{64}$/);
let app, page, exportPath, session = 0;
const report = { schema: "loci.perinuclear-workflow-packaged-qa/v1", status: "running", started_at: startedAt,
  app_bundle: appBundle, output_root: runRoot, expected_candidate: expectedCandidate,
  review: "SIMULATED automated GUI review gate exercise; original interface actor declaration preserved, never human scientific approval",
  limitation: "Synthetic macOS software regression only; no real-data, biological, clinical or cross-platform qualification",
  checkpoints: [], assertions: {}, dialogs: [], page_errors: [], console_errors: [], network_requests: [] };
const records = {};
async function hash(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
async function identity() {
  return { executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker) };
}
const git = async (...args) => (await run("git", args, { cwd: root, maxBuffer: 4 * 1024 ** 2 })).stdout.trim();
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = id => page.evaluate(result_id => window.lociResearch.execute("result", { result_id, offset: 0, limit: 1000 }), id);
async function noUiError(label) {
  for (const alert of await page.locator('.research-alert[role=alert], .adaptive-panel [role=alert], .research-quantification [role=alert], .perinuclear-result [role=alert]').all())
    if (await alert.isVisible()) throw new Error(label + ": " + await alert.innerText());
}
async function wait(read, predicate, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await noUiError(label);
    const state = await snapshot();
    const failed = state?.jobs?.find(job => ["failed", "interrupted", "cancelled"].includes(job.state));
    if (failed) throw new Error(`${label}: durable ${failed.operation} job ${failed.id} ${failed.state}: ${failed.error}`);
    const value = await read();
    if (value != null && predicate(value)) return value;
    await page.waitForTimeout(150);
  }
  throw new Error("No verified completion: " + label);
}
async function capture(name) {
  const file = path.join(runRoot, name + ".png");
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  report.checkpoints.push({ name, at: new Date().toISOString(), sha256: await hash(file) });
  process.stdout.write("Checkpoint: " + name + "\n");
}
async function dialogs() {
  await app.evaluate(({ dialog }, values) => {
    globalThis.lociPerinuclearQaDialogs ??= [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const file = title === "Add microscopy or medical images" ? values.source : title === "Open research study" ? values.study : null;
      if (!file) throw new Error("Unexpected QA native dialog: " + title);
      globalThis.lociPerinuclearQaDialogs.push({ title, file_name: file.split(/[\\/]/).at(-1) });
      return { canceled: false, filePaths: [file] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const filePath = title === "Save research study as" ? values.study : title === "Export reviewed result bundle" ? values.export : null;
      if (!filePath) throw new Error("Unexpected QA native save dialog: " + title);
      globalThis.lociPerinuclearQaDialogs.push({ title, file_name: filePath.split(/[\\/]/).at(-1) });
      return { canceled: false, filePath };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source: sourcePath, study: studyPath, export: exportPath });
}
async function launch() {
  // A fresh profile for each process prevents warm session recovery or caches
  // from substituting for the saved-study native Open study route.
  const userData = path.join(runRoot, "user-data-" + ++session);
  await fs.mkdir(userData);
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData], cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.page_errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.console_errors.push(message.text()); });
  page.on("request", request => { if (/^https?:/.test(request.url())) report.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }));
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await dialogs();
  await page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 60_000 });
}
async function close() {
  if (!app) return;
  report.dialogs.push(...await app.evaluate(() => globalThis.lociPerinuclearQaDialogs ?? []));
  const closing = app;
  const done = closing.waitForEvent("close", { timeout: 30_000 });
  await closing.evaluate(({ app }) => app.quit());
  await done;
  app = undefined; page = undefined;
}
async function openResult(result) {
  const row = page.locator(`button[data-result-id="${result.id}"]`);
  if (!(await row.getAttribute("class"))?.includes("selected")) await row.click();
  await wait(() => row.getAttribute("class"), value => value?.includes("selected"), "selected exact result revision");
  await selectWorkbenchTool(page, "Info");
  await selectResultSection(page, "Review");
}
async function newResult(beforeIds, kind) {
  const state = await wait(snapshot, state => state.results.some(item => !beforeIds.has(item.id)), kind + " published through visible controls");
  const added = state.results.filter(item => !beforeIds.has(item.id));
  assert.equal(added.length, 1);
  const result = added[0];
  assert.equal(result.kind, kind);
  assert.equal(result.review, null);
  const record = await inspect(result.id);
  assert.equal(record.total_rows, 5, "Five explicit synthetic disk objects, not a biological accuracy claim");
  assert.equal(record.measurements.length, 5);
  return record;
}
async function checkQc(child, prefix) {
  await openResult(child);
  const qc = page.getByRole("region", { name: "Inspect perinuclear labels", exact: true });
  const choices = [
    ["nuclei", "Nuclei (all)", "original nucleus labels, including endpoint exclusions"],
    ["rings", "Perinuclear rings (proxy)", "unique perinuclear ring pixels; geometric proxy, not cytoplasm"],
    ["ambiguous", "Shared ring pixels (excluded)", "multiply claimed ring pixels discarded from every ring"],
  ];
  for (const [field, label, basis] of choices) {
    await qc.getByLabel("Perinuclear overlay", { exact: true }).selectOption(field);
    const image = qc.getByAltText(label + " over the saved raw signal channel", { exact: true });
    await wait(() => image.count(), value => value === 1, "QC field " + field);
    await wait(() => image.evaluate(element => element.complete && element.naturalWidth > 0), Boolean, "decoded QC " + field);
    await qc.getByText(basis, { exact: true }).waitFor();
    const view = await page.evaluate(request => window.lociResearch.execute("result_view", request, { viewer_lane: "qa-inspection" }), { result_id: child.id, axis: "z", index: 0, labels: true, label_field: field });
    assert.equal(view.result_id, child.id); assert.equal(view.revision_hash, child.revision_hash);
    assert.equal(view.label_field, field); assert.equal(view.label_field_basis, basis);
    assert.deepEqual(view.shape, [128, 128]); assert.deepEqual(view.geometry, child.geometry);
    await capture(prefix + "-qc-" + field);
  }
  await qc.getByRole("button", { name: "Enlarge label inspection", exact: true }).click();
  const expanded = page.getByRole("dialog", { name: "Perinuclear label inspection", exact: true });
  await expanded.waitFor();
  await expanded.getByRole("button", { name: "Close perinuclear label inspection", exact: true }).click();
  await expanded.waitFor({ state: "hidden" });
}
async function exportNative(destination) {
  exportPath = destination;
  await dialogs();
  await selectResultSection(page, "Export");
  assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Export result", exact: true }).click();
  await wait(async () => {
    try { return JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, Boolean, "atomic native export");
}

await fs.mkdir(runRoot, { recursive: true });
try {
  report.build = await identity();
  for (const [key, value] of Object.entries(report.build)) assert.equal(value, expectedCandidate[key], "Candidate pin mismatch: " + key);
  report.source = { head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"), status: await git("status", "--porcelain"),
    harness_sha256: await hash(import.meta.filename), helper_sha256: await hash(path.join(import.meta.dirname, "workbench-qa-helpers.mjs")), oracle_sha256: await hash(oracleScript),
    candidate_expectation_sha256: process.env.LOCI_QA_CANDIDATE_IDENTITY ? await hash(process.env.LOCI_QA_CANDIDATE_IDENTITY) : null };
  const generated = await run(python, [oracleScript, "create", "--root", fixtureRoot], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
  report.fixture = JSON.parse(generated.stdout);
  report.fixture.manifest_sha256 = await hash(path.join(fixtureRoot, "manifest.json"));
  assert.equal(await hash(sourcePath), report.fixture.sha256);
  await launch();
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace", exact: true }).waitFor();
  const imported = await wait(snapshot, state => state.sources.length === 1, "one generated native CYX source");
  const source = imported.sources[0];
  assert.equal(source.sha256, report.fixture.sha256); assert.equal(source.source_kind, "native");
  assert.deepEqual(source.metadata.dimensions, { x: 128, y: 128, c: 2, z: 1, t: 1, s: 1 });
  assert.ok(!["RGB", "RGBA"].includes(source.metadata.sample_semantics));
  await selectWorkbenchTool(page, "Quantify");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  for (const [index, name] of [[1, "synthetic-DNA-proxy"], [2, "synthetic-raw-signal"]]) {
    await page.getByLabel(`Channel ${index} name`, { exact: true }).fill(name);
    await page.getByLabel(`Channel ${index} declaration`, { exact: true }).fill("Explicit synthetic fixture declaration; no acquired biological marker or fluorophore");
  }
  await page.getByRole("button", { name: "Save declarations at revision 0", exact: true }).click();
  await page.getByRole("button", { name: "Save declarations at revision 1", exact: true }).waitFor();
  records.channels = await page.evaluate(source_id => window.lociResearch.execute("channel_metadata", { source_id }), source.id);
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of [["X", 0], ["Y", 0], ["Width", 128], ["Height", 128], ["C", 0]]) await setSelectionField(page, label, value);
  await wait(() => page.locator(`[data-viewer-source="${source.id}"]`).getAttribute("data-prepared"), value => value === "true", "full native plane");
  // Presentation changes must not alter raw measurements in either channel.
  for (const index of [1, 2]) {
    const channel = page.locator("details.source-channel").filter({ has: page.getByRole("checkbox", { name: `Channel ${index} visible`, exact: true }) });
    if (!(await channel.evaluate(element => element.open))) await channel.locator(":scope > summary").click();
    const gamma = channel.getByLabel(`Channel ${index} gamma`, { exact: true });
    await gamma.fill("2"); await gamma.press("Enter");
    assert.equal(await gamma.getAttribute("aria-invalid"), "false");
  }
  records.source_view = await wait(() => page.evaluate(source_id => window.lociResearch.execute("source_view", { source_id }), source.id),
    view => [0, 1].every(channel => view.state.channels.find(item => item.channel === channel)?.gamma === 2), "both display gamma changes durably saved");
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  const adaptive = page.locator(".adaptive-panel");
  await adaptive.getByLabel("Segmentation input", { exact: true }).selectOption("0");
  await adaptive.getByLabel("Imaging preset", { exact: true }).selectOption("fluorescence");
  await adaptive.getByLabel("Cell polarity", { exact: true }).selectOption("bright");
  for (const [key, label] of [["expected_diameter_px", "Expected diameter"], ["min_area_px", "Minimum cell area"], ["sensitivity", "Sensitivity"], ["smoothing_px", "Edge smoothing"]]) {
    const field = adaptive.getByLabel(label, { exact: true });
    await field.fill(String(report.fixture.settings[key])); await field.press("Enter");
    assert.equal(await field.getAttribute("aria-invalid"), "false");
  }
  await adaptive.getByLabel("Split touching cells", { exact: true }).setChecked(true);
  await adaptive.getByLabel("Exclude border cells", { exact: true }).setChecked(false);
  await adaptive.getByLabel("Adaptive memory allowance", { exact: true }).selectOption(String(workingBytes));
  await capture("01-explicit-synthetic-DNA-adaptive-settings");
  const parentBefore = new Set((await snapshot()).results.map(item => item.id));
  await adaptive.getByRole("button", { name: "Segment image", exact: true }).click();
  records.parent = await newResult(parentBefore, "adaptive-segmentation");
  const parent = records.parent.result;
  assert.equal(parent.source_id, source.id); assert.equal(parent.source_sha256, source.sha256);
  assert.deepEqual(records.parent.provenance.settings, report.fixture.settings);
  assert.equal(records.parent.provenance.selection.c, 0);
  assert.deepEqual(records.parent.provenance.measurement_channels, [0]);
  assert.equal(records.parent.provenance.accepted_request.working_bytes, workingBytes);
  await selectWorkbenchTool(page, "Quantify");
  await page.getByRole("button", { name: "Perinuclear", exact: true }).click();
  const perinuclear = page.getByRole("region", { name: "Perinuclear enrichment", exact: true });
  const measure = perinuclear.getByRole("button", { name: "Measure perinuclear enrichment", exact: true });
  assert.equal(await measure.isEnabled(), false, "Explicit nucleus, signal and controls are required");
  await perinuclear.getByLabel("Perinuclear nucleus result", { exact: true }).selectOption(parent.id + ":" + parent.revision_hash);
  await perinuclear.getByLabel("Perinuclear raw signal channel", { exact: true }).selectOption("1");
  await perinuclear.getByLabel("Perinuclear ring radius (px)", { exact: true }).fill("5");
  assert.equal(await measure.isEnabled(), false, "An empty control declaration cannot publish");
  await perinuclear.getByLabel("Perinuclear controls and assumptions", { exact: true }).fill(control);
  assert.equal(await measure.isEnabled(), true);
  await capture("02-explicit-five-pixel-raw-signal-request");
  const before = new Set((await snapshot()).results.map(item => item.id));
  await measure.click();
  records.child = await newResult(before, "perinuclear-enrichment");
  const child = records.child.result;
  assert.equal(child.parent_id, parent.id);
  assert.deepEqual(child.arrays.labels, parent.arrays.labels);
  assert.equal(records.child.provenance.perinuclear.control, control);
  assert.equal(records.child.provenance.perinuclear.radius_px, 5);
  assert.equal(records.child.provenance.perinuclear.signal_channel, 1);
  const complete = await wait(snapshot, state => state.jobs.some(job => job.operation === "perinuclear_run" && job.state === "succeeded"), "durable perinuclear_run completion");
  const ringJobs = complete.jobs.filter(job => job.operation === "perinuclear_run");
  assert.equal(ringJobs.length, 1);
  const job = ringJobs[0];
  assert.equal(job.error, null); assert.deepEqual(job.result_ids, [child.id]);
  assert.deepEqual(job.request, { source_id: source.id, task_request: { result_id: parent.id, revision_hash: parent.revision_hash, signal_channel: 1, radius_px: 5, working_bytes: workingBytes, control } });
  assert.equal(records.child.provenance.job_id, job.id);
  records.durable_job = job;
  await checkQc(child, "03");
  await selectResultSection(page, "Export");
  assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), false, "Unreviewed export must remain gated");
  await selectResultSection(page, "Review");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await wait(snapshot, state => state.results.find(item => item.id === child.id)?.review?.disposition === "reviewed", "SIMULATED automated review transition only");
  await exportNative(exports[0]);
  records.child = await inspect(child.id);
  report.interface_review_receipt = records.child.result.review;
  await fileMenuAction(page, "Save study");
  await wait(() => fs.stat(path.join(studyPath, "study.sqlite3")).catch(error => { if (error.code === "ENOENT") return null; throw error; }), stat => stat?.size > 0, "saved native study database");
  records.snapshot = await snapshot();
  await capture("04-SIMULATED-review-native-export-and-save");
  await close();
  await launch();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await wait(snapshot, state => state.results.length === 2, "cold native Open study from fresh profile");
  for (const result of records.snapshot.results) assert.deepEqual(reopened.results.find(item => item.id === result.id), result, "Cold reopen preserves complete renderer-safe result identity");
  assert.deepEqual(await inspect(parent.id), records.parent, "Parent revision/provenance/measurements remain immutable");
  assert.deepEqual(await inspect(child.id), records.child, "Child revision/provenance/review/measurements remain exact");
  assert.deepEqual(reopened.jobs.find(item => item.id === job.id), job, "Durable task receipt survives cold reopen");
  assert.deepEqual(await page.evaluate(source_id => window.lociResearch.execute("channel_metadata", { source_id }), source.id), records.channels);
  const reopenedView = await page.evaluate(source_id => window.lociResearch.execute("source_view", { source_id }), source.id);
  assert.deepEqual(reopenedView.state.channels, records.source_view.state.channels, "Display channel metadata survives native study restore");
  await checkQc(child, "05-cold");
  await exportNative(exports[1]);
  await capture("06-cold-reopen-native-export");
  records.snapshot = await snapshot();
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2) + "\n");
  await close();
  const verified = await run(python, [oracleScript, "verify", "--root", fixtureRoot, "--study", studyPath, "--records", recordsPath,
    "--before", exports[0], "--after", exports[1]], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 ** 2 });
  report.oracle = JSON.parse(verified.stdout);
  assert.equal(report.oracle.status, "passed");
  assert.deepEqual(await identity(), report.build, "Candidate components changed during journey");
  assert.equal(await hash(sourcePath), report.fixture.sha256);
  assert.equal(await hash(import.meta.filename), report.source.harness_sha256);
  assert.equal(await hash(oracleScript), report.source.oracle_sha256);
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); assert.deepEqual(report.network_requests, []);
  assert.ok(report.dialogs.some(item => item.title === "Add microscopy or medical images"));
  assert.ok(report.dialogs.some(item => item.title === "Open research study"));
  assert.equal(report.dialogs.filter(item => item.title === "Export reviewed result bundle").length, 2);
  report.assertions = { visible_source_channel_segmentation_and_ring_controls: true, durable_perinuclear_run: true,
    all_qc_selectors_and_enlargement: true, raw_uint64_integer_sums_and_independent_masks: true,
    border_and_zero_ring_exclusions_and_shared_pixels: true, simulated_review_gates_export: true,
    native_save_fresh_profile_cold_reopen_and_export_comparison: true, display_gamma_does_not_change_raw_measurements: true };
  report.study = studyPath; report.exports = exports; report.records_sha256 = await hash(recordsPath);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error.name, message: error.message, stack: error.stack, stdout: error.stdout ?? null, stderr: error.stderr ?? null };
  if (page) {
    await capture("failure").catch(() => {});
    await fs.writeFile(path.join(runRoot, "failure-ui.txt"), await page.locator("body").innerText().catch(() => "UI unavailable"));
    await fs.writeFile(path.join(runRoot, "failure-snapshot.json"), JSON.stringify(await snapshot().catch(() => null), null, 2));
  }
  throw error;
} finally {
  if (app) await close().catch(error => { report.close_error = String(error); report.status = "failed"; process.exitCode = 1; });
  report.finished_at = new Date().toISOString();
  const receipt = path.join(runRoot, "perinuclear-workflow-receipt.json");
  await fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ status: report.status, receipt }) + "\n");
}
