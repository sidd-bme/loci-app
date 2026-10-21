import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

// Root owns serial live execution and visual acceptance. Scientific actions below
// use actual controls. Read-only list/get calls inspect the report saved by those
// controls; they never substitute a computed API response for the UI journey.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const startedAt = new Date().toISOString();
assert.equal(process.platform, "darwin", "The packaged intensity journey requires macOS");
assert.ok(process.env.LOCI_PACKAGED_APP, "Set LOCI_PACKAGED_APP to the exact isolated candidate");
assert.ok(process.env.LOCI_QA_OUTPUT_ROOT, "Set an explicit external LOCI_QA_OUTPUT_ROOT");
assert.ok(path.resolve(process.env.LOCI_QA_OUTPUT_ROOT).startsWith(path.join(root, ".loci/evidence") + path.sep),
  "Keep authored fixtures/profiles under this isolated worktree's ignored evidence root");
const bundle = await fs.realpath(path.resolve(process.env.LOCI_PACKAGED_APP));
const executable = path.join(bundle, "Contents/MacOS/Loci");
const worker = path.join(bundle, "Contents/Resources/loci-engine/loci-engine");
const asar = path.join(bundle, "Contents/Resources/app.asar");
const python = path.join(root, "engine/.venv/bin/python");
const fixtureScript = path.join(root, "scripts/fixtures/experiment_intensity_qa.py");
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT,
  "experiment-intensity-" + startedAt.replaceAll(/[:.]/g, "-"));
await fs.mkdir(path.dirname(runRoot), { recursive: true });
await fs.mkdir(runRoot, { recursive: false });
const userData = path.join(runRoot, "isolated-user-data");
const clonePath = path.join(runRoot, "Saved-intensity.loci-study");
const channel = "1: raw.mean:核/β";
const parts = ["object", "cell", "nuclear", "cytoplasm"];
const assertions = {}, observations = { reports: {}, exports: {}, expected_errors: [], page_errors: [] };
const checkpoints = [], packages = {}, expectedFailedJobs = new Set();
let app, page, setup, fixture;

async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function buildIdentity() {
  return { executable_sha256: await hash(executable), asar_sha256: await hash(asar), worker_sha256: await hash(worker) };
}
const git = async (...args) => (await run("git", args, { cwd: root, maxBuffer: 16 * 1024 ** 2 })).stdout.trim();
async function workingSourceHash() {
  const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 16 * 1024 ** 2 });
  const digest = createHash("sha256");
  for (const relative of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    digest.update(relative).update("\0");
    const file = path.join(root, relative);
    const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) digest.update("deleted\0");
    else if (stat.isSymbolicLink()) digest.update("symlink\0").update(await fs.readlink(file)).update("\0");
    else if (stat.isFile()) digest.update("file\0").update(await hash(file)).update("\0");
    else throw new Error("Unexpected source entry: " + relative);
  }
  return digest.digest("hex");
}
const build = await buildIdentity();
const source = {
  head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
  status: await git("status", "--porcelain"), working_source_sha256: await workingSourceHash(),
  harness_sha256: await hash(path.join(import.meta.dirname, "experiment-intensity.qa.mjs")),
  fixture_script_sha256: await hash(fixtureScript),
};
const intensity = () => page.getByRole("region", { name: "Experiment intensity", exact: true });
const samples = () => page.getByRole("region", { name: "Sample sheet", exact: true });
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const listed = () => page.evaluate(() => window.lociResearch.execute("intensity_list", {}));
const saved = id => page.evaluate(report_id => window.lociResearch.execute("intensity_get", { report_id }), id);
const exists = target => fs.stat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
async function wait(read, accept, message, timeout = 90_000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message + ": " + JSON.stringify(value));
}
async function cleanAlerts(allowed = []) {
  assert.equal(await page.locator(".recoverable-error").filter({ visible: true }).count(), 0, "Unexpected global recoverable error");
  for (const alert of await page.getByRole("alert").all()) {
    if (!(await alert.isVisible())) continue;
    const text = await alert.innerText();
    assert.ok(allowed.some(pattern => pattern.test(text)), "Unexpected alert: " + text);
  }
  assert.deepEqual(observations.page_errors, [], "Unhandled renderer exception");
}
async function layout() {
  return page.evaluate(() => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const selectors = ".experiment-intensity, .sample-sheet";
    const roots = [...document.querySelectorAll(selectors)].filter(visible);
    const clipped = roots.flatMap(region => [...region.querySelectorAll("button, legend, h2, h3, summary, label")]
      .filter(visible).filter(element => !element.closest(".intensity-table") && element.scrollWidth > element.clientWidth + 1)
      .map(element => ({ tag: element.tagName, text: element.textContent.trim(), width: element.clientWidth, scroll: element.scrollWidth })));
    const tables = roots.flatMap(region => [...region.querySelectorAll(".intensity-table")].filter(visible)
      .map(element => ({ label: element.getAttribute("aria-label"), role: element.getAttribute("role"), tab_index: element.tabIndex,
        width: element.clientWidth, scroll: element.scrollWidth })));
    const unbroken = roots.flatMap(region => [...region.querySelectorAll(".intensity-table td, .intensity-table code, .intensity-table button")]
      .filter(visible).filter(element => element.matches("code, button") || /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:\s*\/\s*\d+)*$/iu.test(element.textContent.trim()))
      .filter(element => { const range = document.createRange(); range.selectNodeContents(element);
        const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => Math.round(rect.top * 2) / 2));
        return lines.size > 1; })
      .map(element => element.textContent.trim()));
    const captions = roots.flatMap(region => [...region.querySelectorAll(".intensity-table caption")].filter(visible)
      .filter(element => element.getBoundingClientRect().width > element.closest(".intensity-table").clientWidth + 1)
      .map(element => element.textContent.trim()));
    const plots = roots.flatMap(region => [...region.querySelectorAll(".intensity-plot")].filter(visible)
      .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.scrollWidth));
    return { width: innerWidth, height: innerHeight, document_width: document.documentElement.scrollWidth,
      theme: document.documentElement.dataset.theme, clipped_labels: clipped, wrapped_numbers_or_identity: unbroken,
      overflowing_captions: captions, overflowing_plots: plots, tables };
  });
}
async function shot(name, target, allowed = []) {
  await cleanAlerts(allowed);
  if (target) await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await layout();
  assert.ok(bounds.document_width <= bounds.width + 1, "App-wide horizontal overflow: " + JSON.stringify(bounds));
  assert.deepEqual(bounds.clipped_labels, [], "Clipped essential labels: " + JSON.stringify(bounds.clipped_labels));
  assert.deepEqual(bounds.wrapped_numbers_or_identity, [], "Exact values and revision actions must stay unbroken");
  assert.deepEqual(bounds.overflowing_captions, [], "Table captions must fit the panel");
  assert.deepEqual(bounds.overflowing_plots, [], "Replicate plot must fit the panel");
  assert.ok(bounds.tables.every(table => table.role === "region" && table.label && table.tab_index === 0), "Tables need named keyboard-scroll regions");
  await page.screenshot({ path: path.join(runRoot, name + ".png"), fullPage: true });
  checkpoints.push({ name, ...bounds });
  process.stdout.write("Checkpoint: " + name + "\n");
}
async function mainDialogValues(values) {
  await app.evaluate((_electron, update) => Object.assign(globalThis.intensityQa, update), values);
}
async function launch(openPath) {
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData], cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => observations.page_errors.push(String(error)));
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) { win.setFocusable(false); win.blur(); }
    app.hide();
  });
  await app.evaluate(({ BrowserWindow, dialog }, values) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 940 });
    globalThis.intensityQa = { ...values, dialogs: [], holdPicker: false, resolvePicker: null };
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      globalThis.intensityQa.dialogs.push({ kind: "open", title });
      if (title !== "Open research study") throw new Error("Unexpected QA open dialog: " + title);
      return { canceled: false, filePaths: [globalThis.intensityQa.openPath] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const state = globalThis.intensityQa;
      state.dialogs.push({ kind: "save", title });
      if (title === "Save research study as") return { canceled: false, filePath: state.clonePath };
      if (title !== "Export intensity comparison") throw new Error("Unexpected QA save dialog: " + title);
      if (state.holdPicker) return new Promise(resolve => { state.resolvePicker = resolve; });
      return { canceled: false, filePath: state.exportPath };
    };
  }, { openPath, clonePath, exportPath: path.join(runRoot, "not-yet-exported") });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await fileMenuAction(page, "Open study");
  await waitForSnapshot(page, state => state?.sources?.length === Object.keys(fixture.records).length &&
    Object.values(fixture.records).every(record => [record.object, record.compartment].every(binding => state.results.some(result => result.id === binding.result_id))), "fresh exact intensity fixture", 120_000);
  await selectWorkbenchTool(page, "Study");
  await samples().waitFor(); await intensity().waitFor();
}
async function closeApp() {
  if (!app) return;
  observations.native_dialogs ??= [];
  observations.native_dialogs.push(...await app.evaluate(() => globalThis.intensityQa?.dialogs ?? []));
  // A failed picker probe must release its owned promise before shutdown.
  await app.evaluate(() => { const state = globalThis.intensityQa; if (state?.resolvePicker) {
    state.resolvePicker({ canceled: true }); state.resolvePicker = null;
  } }).catch(() => {});
  await app.close(); app = undefined;
}
async function samplePreview() {
  await samples().getByRole("button", { name: "Preview sample sheet", exact: true }).click();
  await samples().getByRole("region", { name: "Sample sheet before and after", exact: true }).waitFor();
}
async function sampleApply(expectedRows) {
  await samples().getByRole("button", { name: "Apply sample sheet", exact: true }).click();
  await samples().getByText(`Applied sample metadata for ${expectedRows} images.`, { exact: true }).waitFor({ timeout: 120_000 });
}
async function details(name) {
  const summary = intensity().locator("summary").filter({ hasText: name });
  const disclosure = summary.locator("..");
  if (!(await disclosure.evaluate(element => element.open))) await summary.click();
}
async function choose(part) {
  const another = intensity().getByRole("button", { name: "Set up another comparison", exact: true });
  if (await another.count()) await another.click();
  for (const box of await intensity().getByRole("checkbox").all()) if (await box.isChecked()) await box.uncheck();
  const kind = part === "object" ? "object" : "compartment";
  for (const record of Object.values(fixture.records)) {
    const box = intensity().getByRole("checkbox", { name: "Intensity result " + record[kind].result_id, exact: true });
    if (record.disposition === "pending") {
      assert.equal(await box.isDisabled(), true, "Pending revisions must be blocked");
      assert.match(await box.locator("..").innerText(), /Blocked until reviewed/u);
    } else {
      await box.check();
      const alternative = record[kind === "object" ? "compartment" : "object"];
      assert.equal(await intensity().getByRole("checkbox", { name: "Intensity result " + alternative.result_id, exact: true }).isDisabled(), true,
        "A second revision on the same source must be blocked");
    }
  }
  const compartment = intensity().getByLabel("Intensity compartment", { exact: true });
  await wait(() => compartment.locator("option").evaluateAll(options => options.map(option => option.value)), values => values.includes(part), "actual stored compartment choice");
  await compartment.selectOption(part);
  const metric = "intensity:" + Buffer.from(channel, "utf8").toString("hex") + ":mean";
  const literal = part === "object" ? metric : "compartment:" + part + ":" + metric;
  for (const record of Object.values(fixture.records).filter(record => record.disposition !== "pending"))
    await intensity().getByLabel("Intensity channel for " + record[kind].result_id, { exact: true }).selectOption(literal);
  await intensity().getByLabel("Shared channel declaration", { exact: true }).fill("Authored raw.mean:核/β channel");
  await intensity().getByLabel("Acquisition context", { exact: true }).fill("Same authored float64 source generation, 32 × 32 native grid, no acquisition correction.");
  await intensity().getByLabel("Comparability rationale", { exact: true }).fill("Constant synthetic source intensity within authored cells; identical executed segmentation and compartment definitions. This declaration does not establish biological identity or calibration.");
  assertions.pending_blocked_and_one_revision_per_source = true;
}
async function oracleTables() {
  const table = intensity().getByRole("region", { name: "Intensity condition means", exact: true });
  await table.waitFor();
  const cells = await table.getByRole("rowheader", { name: "A", exact: true }).locator("..").getByRole("cell").allTextContents();
  assert.equal(Number(cells[0]), 30); assert.ok(Math.abs(Number(cells[1]) - Math.sqrt(200)) < 1e-12);
  assert.equal(cells[2].replaceAll(/\s/g, ""), "102/102");
  assert.equal(cells[3].replaceAll(/\s/g, ""), "3/3");
  assert.equal(cells[4].replaceAll(/\s/g, ""), "2/2");
}
async function preview(part) {
  await choose(part);
  await intensity().getByRole("button", { name: "Preview intensity comparison", exact: true }).click();
  await intensity().getByRole("heading", { name: "Comparison preview", exact: true }).waitFor({ timeout: 120_000 });
  await oracleTables();
  await details(/^Declared replicate means/u); await details(/^Image means & inclusion reasons/u);
  await intensity().getByRole("region", { name: "Intensity image means", exact: true }).getByText(/excluded-by-review/u).waitFor();
}
async function saveReport(part) {
  const beforeIds = new Set((await listed()).reports.map(row => row.id));
  await intensity().getByRole("button", { name: "Save intensity report", exact: true }).click();
  await intensity().getByRole("heading", { name: "Saved intensity report", exact: true }).waitFor({ timeout: 120_000 });
  const next = await wait(listed, value => value.reports.filter(row => !beforeIds.has(row.id)).length === 1, "new immutable intensity report");
  const id = next.reports.find(row => !beforeIds.has(row.id)).id;
  const value = await saved(id);
  assert.equal(value.report_id, id); assert.equal(value.report.report_hash.slice(0, 32), id);
  assert.equal(value.report.endpoint.compartment, part); assert.equal(value.status.current, true);
  assert.equal(value.report.software.implementation.kind, "frozen-executable-sha256");
  assert.equal(value.report.software.implementation.sha256, build.worker_sha256);
  observations.reports[id] = value.report;
  return value;
}
async function openReport(id) {
  await details(/^Saved intensity reports/u);
  const button = intensity().getByRole("button", { name: "Open intensity report " + id, exact: true });
  await button.scrollIntoViewIfNeeded(); await button.focus(); await page.keyboard.press("Enter");
  await intensity().getByRole("heading", { name: "Saved intensity report", exact: true }).waitFor();
  await oracleTables();
  assert.deepEqual((await saved(id)).report, observations.reports[id], "Reopen must preserve the entire exact saved report");
}
async function inspectAndReturn(binding, heading) {
  await details(/^Image means & inclusion reasons/u);
  const button = intensity().getByRole("button", { name: "Inspect rev " + binding.revision_hash.slice(0, 8), exact: true });
  await button.scrollIntoViewIfNeeded(); await button.click();
  await wait(() => page.locator(`[data-result-id="${binding.result_id}"]`).getAttribute("aria-pressed"), value => value === "true", "exact inspected result/source coherence");
  const sourceRecord = Object.values(fixture.records).find(record => [record.object, record.compartment].some(row => row.result_id === binding.result_id));
  assert.ok(sourceRecord, "Inspected exact revision must map to an authored source");
  assert.equal(await page.locator(`button[data-source-id="${sourceRecord.source_id}"]`).getAttribute("aria-current"), "true");
  await selectWorkbenchTool(page, "Study");
  await intensity().getByRole("heading", { name: heading, exact: true }).waitFor();
  await oracleTables();
}
async function packageIdentity(target) {
  return Object.fromEntries(await Promise.all((await fs.readdir(target)).sort().map(async name => [name, await hash(path.join(target, name))])));
}
async function exportReport(name, id) {
  const target = path.join(runRoot, name);
  await mainDialogValues({ exportPath: target, holdPicker: false });
  await intensity().getByRole("button", { name: "Export intensity report…", exact: true }).click();
  await intensity().getByText(`Saved ${name}. Exact saved report values and provenance were exported.`, { exact: true }).waitFor({ timeout: 120_000 });
  await fs.access(path.join(target, "manifest.json"));
  const report = JSON.parse(await fs.readFile(path.join(target, "report.json"), "utf8"));
  assert.deepEqual(report, observations.reports[id], "Export must use the entire exact immutable saved snapshot");
  const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.export_software.kind, "frozen-executable-sha256");
  assert.equal(manifest.export_software.sha256, build.worker_sha256);
  const verify = await run(python, [fixtureScript, "verify", setup.manifest, target], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
  const py = await run(python, ["-B", path.join(target, "read_report.py"), target], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
  const r = await run("Rscript", [path.join(target, "read_report.R"), target], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 ** 2 });
  observations.exports[name] = { report_id: id, oracle: JSON.parse(verify.stdout), python: py.stdout, r: r.stdout, files: await packageIdentity(target) };
  packages[name] = target;
  await cleanAlerts();
  return target;
}
async function appearance(theme, large = false, reduced = false) {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Application theme", { exact: true }).selectOption(theme);
  await page.getByRole("radiogroup", { name: "Interface text size", exact: true }).getByRole("radio", { name: large ? "Large" : "Standard", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Interface motion", exact: true }).getByRole("radio", { name: reduced ? /Reduce motion/u : /Follow system/u }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
}
async function expectedAlert(region, pattern, name) {
  const alert = region.getByRole("alert").filter({ hasText: pattern });
  await alert.waitFor({ timeout: 120_000 });
  observations.expected_errors.push({ name, text: await alert.innerText() });
  assert.equal(/invoking remote|loci-research/u.test(await alert.innerText()), false, "User errors must be actionable");
  return alert;
}

async function runningBodyCancellation() {
  const probe = fixture.cancellation;
  await mainDialogValues({ openPath: probe.study_path });
  await fileMenuAction(page, "Open study");
  await waitForSnapshot(page, state => state.sources.length === 1 && state.results.some(row => row.id === probe.result_id), "separate authored cancellation study", 120_000);
  await selectWorkbenchTool(page, "Study");
  await samples().getByLabel("Sample sheet file", { exact: true }).setInputFiles(probe.samples_csv);
  await wait(() => samples().getByLabel("Sample sheet CSV", { exact: true }).inputValue(), text => text.includes(probe.source_id), "cancellation sample CSV");
  await samplePreview(); await sampleApply(1);
  await intensity().getByRole("checkbox", { name: "Intensity result " + probe.result_id, exact: true }).check();
  await intensity().getByLabel("Intensity compartment", { exact: true }).selectOption("object");
  const metric = intensity().getByLabel("Intensity channel for " + probe.result_id, { exact: true });
  await wait(() => metric.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean)), values => values.length === 1, "single actual cancellation measurement descriptor");
  await metric.selectOption(await metric.locator("option").evaluateAll(options => options.map(option => option.value).find(Boolean)));
  await intensity().getByLabel("Shared channel declaration", { exact: true }).fill("Authored single grayscale raw channel");
  await intensity().getByLabel("Acquisition context", { exact: true }).fill("Authored 302 × 302 float64 native grid with 10,000 isolated pixels at raw value 11.");
  await intensity().getByLabel("Comparability rationale", { exact: true }).fill("One reviewed result from one authored source; this fixture exercises cooperative export cancellation without inferring biological validity.");
  await intensity().getByRole("button", { name: "Preview intensity comparison", exact: true }).click();
  await intensity().getByRole("heading", { name: "Comparison preview", exact: true }).waitFor({ timeout: 120_000 });
  const value = await saveReport("object");
  delete observations.reports[value.report_id];
  assert.equal(value.report.observations.length, 10_000);
  const target = path.join(runRoot, "cancelled-running-body-must-not-exist");
  await mainDialogValues({ exportPath: target, holdPicker: false });
  await intensity().getByRole("button", { name: "Export intensity report…", exact: true }).click();
  const stageNames = await wait(() => fs.readdir(runRoot), names => names.some(name => name.startsWith(".loci-intensity-")), "actual intensity export staging began", 120_000);
  const ownedStages = stageNames.filter(name => name.startsWith(".loci-intensity-"));
  await intensity().getByRole("button", { name: "Cancel intensity export", exact: true }).click();
  const settled = await wait(snapshot, state => state.jobs.some(job => job.operation === "intensity_export" && job.state === "cancelled") && state.jobs.every(job => !["queued", "running"].includes(job.state)), "durable cooperative running-body cancellation", 120_000);
  assert.equal(await exists(target), false, "Cancelled running body must not publish");
  for (const name of ownedStages) assert.equal(await exists(path.join(runRoot, name)), false, "Cancelled running body must remove its owned stage");
  for (const [file, expected] of Object.entries(probe.source_hashes)) assert.equal(await hash(file), expected);
  observations.running_body_cancellation = { report_id: value.report_id, object_count: 10_000, observed_stages: ownedStages, jobs: settled.jobs, published: false, owned_stages_removed: true };
  assertions.actual_running_body_cooperative_cancellation_no_publication = true;
  await cleanAlerts();
  await mainDialogValues({ openPath: setup.study_path });
  await fileMenuAction(page, "Open study");
  await waitForSnapshot(page, state => state.sources.length === 8 && state.results.some(row => row.id === fixture.records.A100.object.result_id), "return to main authored study", 120_000);
  await selectWorkbenchTool(page, "Study");
}

try {
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle], { cwd: root, timeout: 60_000 });
  setup = JSON.parse((await run(python, [fixtureScript, "create", path.join(runRoot, "synthetic-fixture")], { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 ** 2 })).stdout);
  fixture = JSON.parse(await fs.readFile(setup.manifest, "utf8"));
  assert.equal(fixture.schema, "loci.intensity-qa-fixture/v1");
  await launch(setup.study_path);
  observations.initial_result_bindings = (await snapshot()).results.map(row => [row.id, row.revision_hash]);
  await samples().getByRole("button", { name: "Load sample sheet template", exact: true }).click();
  const csvBox = samples().getByLabel("Sample sheet CSV", { exact: true });
  await wait(() => csvBox.inputValue(), text => text.includes(fixture.records.A100.source_id), "stable-ID CSV template");
  assertions.actual_stable_source_template = true;
  const csv = await fs.readFile(fixture.samples_csv, "utf8");
  const lines = csv.trimEnd().split("\n");
  await csvBox.fill(csv + lines[1] + "\n"); await samplePreview();
  const duplicateIssue = samples().getByRole("region", { name: "Sample sheet before and after", exact: true }).getByText(/Duplicate source_id/iu).first();
  await duplicateIssue.waitFor();
  observations.expected_errors.push({ name: "duplicate CSV source", text: await duplicateIssue.innerText() });
  assert.equal(await samples().getByRole("button", { name: "Apply sample sheet", exact: true }).isDisabled(), true);
  const unknown = lines[1].replace(fixture.records.A100.source_id, "f".repeat(32));
  await csvBox.fill(lines[0] + "\n" + unknown + "\n"); await samplePreview();
  const unknownIssue = samples().getByRole("region", { name: "Sample sheet before and after", exact: true }).getByText(/Unknown source_id/iu).first();
  await unknownIssue.waitFor();
  observations.expected_errors.push({ name: "unknown CSV source", text: await unknownIssue.innerText() });
  assert.equal(await samples().getByRole("button", { name: "Apply sample sheet", exact: true }).isDisabled(), true);
  await shot("01-csv-unknown-blocked", samples().getByRole("region", { name: "Sample sheet before and after", exact: true }), [/unknown|unmatched|not registered/iu]);
  await samples().getByLabel("Sample sheet file", { exact: true }).setInputFiles(fixture.samples_csv);
  await wait(() => csvBox.inputValue(), text => text === csv, "UTF-8 file input retained exact CSV");
  await samplePreview();
  const beforeAfter = samples().getByRole("region", { name: "Sample sheet before and after", exact: true });
  assert.equal(await beforeAfter.locator("tbody tr").count(), 8);
  assert.match(await beforeAfter.innerText(), /No sample metadata/u);
  await shot("02-csv-every-before-after", beforeAfter);
  // The only out-of-band mutation is an authored synthetic fixture race. Apply
  // itself remains the actual user action, and the exact stale preview must fail.
  const mutation = [
    "import sys", "from pathlib import Path", "sys.path.insert(0,sys.argv[1])",
    "from loci_engine.research_project import ResearchProject", "p=ResearchProject(Path(sys.argv[2]))",
    "p.put_document('sample',sys.argv[3],{'study':'Authored intensity comparison','sample':'Pending stale probe','condition':'A','biological_replicate':'R4','plate':None,'well':None},expected_revision=0)",
  ].join("\n");
  await run(python, ["-B", "-c", mutation, path.join(root, "engine/src"), setup.study_path, fixture.records.Pending.source_id], { cwd: root, timeout: 60_000 });
  const raceState = (await snapshot()).samples;
  await samples().getByRole("button", { name: "Apply sample sheet", exact: true }).click();
  const staleError = await expectedAlert(samples(), /stale|preview again/iu, "stale sample preview");
  assert.deepEqual((await snapshot()).samples, raceState, "Stale apply must not partially update sample metadata");
  await shot("03-csv-stale-apply-rejected", staleError, [/stale|preview again/iu]);
  await samplePreview(); await sampleApply(8);
  assert.equal((await snapshot()).samples.length, 8);
  assertions.csv_file_duplicate_unknown_stale_atomic_apply_and_recovery = true;

  await page.locator(`button[data-source-id="${fixture.records.A100.source_id}"]`).click();
  await page.locator(`[data-result-id="${fixture.records.A100.object.result_id}"]`).click();
  await selectWorkbenchTool(page, "Info");
  await page.getByRole("button", { name: "Compare intensity in Study & batch", exact: true }).click();
  await intensity().waitFor();
  await wait(() => intensity().getByRole("checkbox", { name: "Intensity result " + fixture.records.A100.object.result_id, exact: true }).isChecked(), Boolean, "current result comparison seeded");
  assert.equal(await intensity().getByRole("checkbox", { name: "Intensity result " + fixture.records.A100.object.result_id, exact: true }).isChecked(), true);
  assertions.direct_current_result_route_to_study_intensity = true;
  const reportIds = {};
  for (const part of parts) {
    await preview(part);
    await shot("04-" + part + "-preview", intensity().getByRole("region", { name: "Intensity condition means", exact: true }));
    if (part === "object") {
      const declaration = await intensity().getByLabel("Comparability rationale", { exact: true }).inputValue();
      await inspectAndReturn(fixture.records.A30.object, "Comparison preview");
      assert.equal(await intensity().getByLabel("Comparability rationale", { exact: true }).inputValue(), declaration);
      assert.equal(await intensity().getByRole("checkbox", { name: "Intensity result " + fixture.records.A100.object.result_id, exact: true }).isChecked(), true);
      assertions.preview_exact_revision_inspection_preserves_draft = true;
    }
    const value = await saveReport(part); reportIds[part] = value.report_id;
    await exportReport("report-" + part, value.report_id);
  }
  assertions.all_four_actual_endpoint_oracles_and_python_r_readers = true;
  await openReport(reportIds.object);
  await inspectAndReturn(fixture.records.A40.object, "Saved intensity report");
  assertions.saved_report_inspection_preserves_snapshot = true;

  await runningBodyCancellation();
  await openReport(reportIds.object);

  const cancelTarget = path.join(runRoot, "cancelled-picker-must-not-exist");
  const jobsBefore = (await snapshot()).jobs.map(job => job.id).sort();
  await mainDialogValues({ holdPicker: true, exportPath: cancelTarget });
  await intensity().getByRole("button", { name: "Export intensity report…", exact: true }).click();
  await wait(() => app.evaluate(() => Boolean(globalThis.intensityQa.resolvePicker)), Boolean, "held title-specific export picker");
  await shot("05-owned-export-picker-cancellable", intensity().getByRole("button", { name: "Cancel intensity export", exact: true }));
  await intensity().getByRole("button", { name: "Cancel intensity export", exact: true }).click();
  await intensity().getByText(/^Cancellation requested\./u).waitFor();
  await app.evaluate(() => { const state = globalThis.intensityQa; state.resolvePicker({ canceled: true }); state.resolvePicker = null; state.holdPicker = false; });
  await wait(() => intensity().getByRole("button", { name: "Export intensity report…", exact: true }).isEnabled(), Boolean, "picker cancellation recovery");
  assert.equal(await exists(cancelTarget), false);
  assert.deepEqual((await snapshot()).jobs.map(job => job.id).sort(), jobsBefore, "Picker cancellation must not submit an export job");
  assertions.actual_panel_picker_cancellation_no_job_no_publication = true;

  const prior = packages["report-object"], priorFiles = await packageIdentity(prior);
  await mainDialogValues({ exportPath: prior });
  await intensity().getByRole("button", { name: "Export intensity report…", exact: true }).click();
  const conflict = await expectedAlert(intensity(), /absent|overwrite|already exists|existing/iu, "existing export destination");
  const conflictState = await snapshot();
  for (const job of conflictState.jobs.filter(job => job.operation === "intensity_export" && job.state === "failed")) {
    assert.match(job.error ?? "", /absent|overwrite|already exists|existing/iu); expectedFailedJobs.add(job.id);
  }
  assert.deepEqual(await packageIdentity(prior), priorFiles, "Destination conflicts must preserve every prior package file");
  await shot("06-no-replace-error", conflict, [/absent|overwrite|already exists|existing/iu]);
  await exportReport("report-object-fresh-retry", reportIds.object);
  assert.deepEqual(await packageIdentity(prior), priorFiles);
  assertions.no_replace_and_fresh_plan_retry = true;

  // Change only the previously unassigned B image through actual metadata UI.
  const changedLine = lines.find(line => line.startsWith(fixture.records.Unassigned.source_id + ",")).split(",");
  changedLine[4] = "R3";
  await samples().getByLabel("Sample sheet CSV", { exact: true }).fill(lines[0] + "\n" + changedLine.join(",") + "\n");
  await samplePreview(); await sampleApply(1);
  await openReport(reportIds.object);
  await intensity().getByText("Current inputs differ. Saved values remain unchanged.", { exact: true }).waitFor();
  const unchanged = await saved(reportIds.object);
  assert.equal(unchanged.status.current, false);
  assert.deepEqual(unchanged.report, observations.reports[reportIds.object]);
  await shot("07-saved-snapshot-current-inputs-differ", intensity().getByRole("region", { name: "Saved intensity report", exact: true }));
  await intensity().getByRole("button", { name: "Recompute as new preview", exact: true }).click();
  await intensity().getByRole("heading", { name: "Comparison preview", exact: true }).waitFor({ timeout: 120_000 });
  await oracleTables();
  const recomputed = await saveReport("object");
  assert.notEqual(recomputed.report_id, reportIds.object);
  assert.equal(recomputed.report.conditions.find(row => row.condition === "B").valid_replicate_count, 3);
  assert.equal(observations.reports[reportIds.object].conditions.find(row => row.condition === "B").valid_replicate_count, 2);
  await exportReport("report-object-recomputed", recomputed.report_id);
  assertions.saved_current_input_separation_and_explicit_new_report = true;

  // One bounded visual matrix. The root inspects these real screenshots, applies
  // any repair batch, and records its confirmation separately from this runner.
  await details(/^Declared replicate means/u); await details(/^Image means & inclusion reasons/u);
  const recomputeButton = intensity().getByRole("button", { name: "Recompute as new preview", exact: true });
  await recomputeButton.focus(); await page.keyboard.press("Tab");
  const nextButton = intensity().getByRole("button", { name: "Set up another comparison", exact: true });
  assert.equal(await nextButton.evaluate(element => document.activeElement === element && element.matches(":focus-visible")), true);
  for (const theme of ["graphite", "paper"]) for (const [width, height] of [[1024, 720], [1440, 940]]) {
    await appearance(theme);
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { width, height });
    await shot(`08-${theme}-${width}-conditions`, intensity().getByRole("region", { name: "Intensity condition means", exact: true }));
    await shot(`08-${theme}-${width}-images`, intensity().getByRole("region", { name: "Intensity image means", exact: true }));
  }
  await appearance("paper", true, true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 720 }));
  await shot("09-paper-1024-large-text-reduced-motion", intensity().getByRole("region", { name: "Intensity condition means", exact: true }));
  observations.appearance = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
    preferences: JSON.parse(localStorage.getItem("loci.preferences.v1")) }));
  assert.equal(observations.appearance.preferences.textSize, "large");
  assert.equal(observations.appearance.preferences.motion, "reduced");
  const scrollTable = intensity().getByRole("region", { name: "Intensity condition means", exact: true });
  await scrollTable.focus(); await page.keyboard.press("ArrowRight");
  await wait(() => scrollTable.evaluate(element => element.scrollLeft), value => value > 0, "keyboard horizontal table scrolling");
  await page.keyboard.press("ArrowLeft");
  await wait(() => scrollTable.evaluate(element => element.scrollLeft), value => value === 0, "keyboard table scroll return");
  assertions.actual_theme_width_large_text_reduced_motion_keyboard_and_overflow = true;

  const retained = await listed(), frozenReports = {};
  for (const row of retained.reports) frozenReports[row.id] = (await saved(row.id)).report;
  await mainDialogValues({ openPath: clonePath });
  await fileMenuAction(page, "Save study");
  await wait(() => exists(path.join(clonePath, "study.sqlite3")), Boolean, "native saved study clone", 120_000);
  await cleanAlerts();
  await closeApp();
  await launch(clonePath);
  assert.deepEqual((await listed()).reports, retained.reports, "Cold native reopen must preserve saved report list");
  for (const [id, report] of Object.entries(frozenReports)) assert.deepEqual((await saved(id)).report, report);
  await openReport(reportIds.nuclear);
  await shot("10-native-cold-reopened-exact-nuclear-report", intensity().getByRole("region", { name: "Saved intensity report", exact: true }));
  const final = await snapshot();
  assert.deepEqual(final.results.map(row => [row.id, row.revision_hash]), observations.initial_result_bindings);
  assert.ok(final.jobs.filter(job => job.operation === "intensity_export").length >= 6);
  assert.ok(final.jobs.every(job => !["failed", "interrupted", "cancelled"].includes(job.state) || expectedFailedJobs.has(job.id)), "Unexpected failed/cancelled/interrupted job");
  assert.ok(final.jobs.every(job => !["queued", "running"].includes(job.state)), "Unsettled job at completion");
  observations.final_jobs = final.jobs;
  assertions.native_save_close_cold_open_exact_reports_results = true;
  await cleanAlerts();
  await closeApp();
  for (const [file, expected] of Object.entries(fixture.source_hashes)) assert.equal(await hash(file), expected, "Synthetic source bytes changed");
  assert.deepEqual(await buildIdentity(), build, "The tested candidate changed during the journey");
  assert.equal(await workingSourceHash(), source.working_source_sha256, "The source tree changed during the journey");
  assert.equal((await fs.readdir(runRoot)).some(name => name.startsWith(".loci-intensity-")), false, "Owned export staging residue");
  assertions.source_result_app_immutability_and_no_unexpected_jobs_errors = true;
  await fs.writeFile(path.join(runRoot, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  const receipt = { schema: "loci.experiment-intensity-packaged-qa/v1", status: "passed", started_at: startedAt,
    finished_at: new Date().toISOString(), build, source, fixture_manifest: setup.manifest, saved_study: clonePath,
    user_data: userData, packages, assertions, checkpoints, visual_review: "Screenshots captured; lead inspection and any repair confirmation required separately.",
    limitations: "Authored synthetic macOS engineering journey. No biological, clinical, independent-sampling or cross-platform validation." };
  await fs.writeFile(path.join(runRoot, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(runRoot, "failure.png"), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(runRoot, "failure-ui.txt"), await page.locator("body").innerText().catch(() => "unavailable"));
  }
  await fs.writeFile(path.join(runRoot, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  await fs.writeFile(path.join(runRoot, "receipt.json"), JSON.stringify({ schema: "loci.experiment-intensity-packaged-qa/v1",
    status: "failed", started_at: startedAt, finished_at: new Date().toISOString(), build, source,
    fixture_manifest: setup?.manifest, assertions, checkpoints, error: String(error) }, null, 2) + "\n");
  throw error;
} finally { await closeApp(); }
