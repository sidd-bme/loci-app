import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, revealExternalLabels, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";

// Successful scientific actions use the real packaged controls. Read-only
// bridge inspection supplies assertions; explicit rejection probes exercise
// backend export guards that the disabled UI deliberately cannot invoke.
// The lead owns serial launch/build resources. Inputs are authored synthetic data.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const startedAt = new Date().toISOString();
assert.equal(process.platform, "darwin", "This packaged journey requires macOS");
assert.ok(process.env.LOCI_PACKAGED_APP, "Choose an explicit candidate with LOCI_PACKAGED_APP");
const appBundle = await fs.realpath(path.resolve(process.env.LOCI_PACKAGED_APP));
const executable = path.join(appBundle, "Contents/MacOS/Loci");
const worker = path.join(appBundle, "Contents/Resources/loci-engine/loci-engine");
const asar = path.join(appBundle, "Contents/Resources/app.asar");
const python = path.join(root, "engine/.venv/bin/python");
const oracleScript = path.join(root, "scripts/fixtures/correction_effect_qa.py");
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(root, ".loci/qa"),
  "correction-effect-" + startedAt.replaceAll(/[:.]/g, "-"));
const userData = path.join(runRoot, "user-data");
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const studyPath = path.join(runRoot, "correction-effect.loci-study");
const exportPath = path.join(runRoot, "reviewed-report");
const rejectedExportPath = path.join(runRoot, "must-not-publish-stale-report");
const archivePath = path.join(runRoot, "portable-study.zip");
const importedStudyPath = path.join(runRoot, "imported-effect.loci-study");
const recordsPath = path.join(runRoot, "inspected-records.json");
const fields = ["r1-corrected", "r1-context", "r2-field-a", "r2-field-b", "r2-field-c"];
const sourcePath = name => path.join(fixtureRoot, name + "-source.tiff");
const labelsPath = name => path.join(fixtureRoot, name + "-labels.tiff");
const assertions = {};
const records = { results: {} };
const checkpoints = [];
let app;
let page;
let nativeDialogs = [];
let exportDestination = exportPath;

async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function buildIdentity() {
  return { executable_sha256: await hash(executable), worker_sha256: await hash(worker), asar_sha256: await hash(asar) };
}
const git = async (...args) => (await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
async function workingSourceHash() {
  const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  const digest = createHash("sha256");
  for (const relative of stdout.split("\0").filter(Boolean).sort()) {
    digest.update(relative).update("\0");
    const file = path.join(root, relative);
    const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) digest.update("deleted\0");
    else if (stat.isSymbolicLink()) digest.update("symlink\0").update(await fs.readlink(file)).update("\0");
    else if (stat.isFile()) digest.update("file\0").update(await hash(file)).update("\0");
    else throw new Error("Unsupported source entry: " + relative);
  }
  return digest.digest("hex");
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = result_id => page.evaluate(id => window.lociResearch.execute("result", { result_id: id, limit: 1000 }), result_id);
const resultBindings = state => state.results.map(item => ({ id: item.id, revision_hash: item.revision_hash, arrays: item.arrays }))
  .sort((a, b) => a.id.localeCompare(b.id));
const comparisonDocuments = state => [...state.comparisons].sort((a, b) => a.id.localeCompare(b.id));
function receiptOracle(receipt, parents, child, moved = false) {
  assert.equal(receipt.schema, "loci.study-correction-effect/v1");
  assert.equal(receipt.unit, "pixel^2");
  assert.equal(receipt.p_values, null);
  assert.equal(receipt.images.length, 5);
  assert.equal(receipt.replicates.length, 2);
  assert.equal(receipt.conditions.length, 1);
  assert.deepEqual(receipt.before_bindings.map(item => item.result_id).sort(), parents.map(item => item.id).sort());
  assert.deepEqual(receipt.after_bindings.map(item => item.result_id).sort(), [child, ...parents.slice(1)].map(item => item.id).sort());
  const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
  const condition = receipt.conditions[0];
  assert.equal(condition.biological_n, 2);
  assert.equal(condition.image_pair_count, 5);
  assert.equal(condition.omitted_image_pair_count, 0);
  close(condition.before_mean, moved ? 103 / 12 : 8.5);
  close(condition.after_mean, moved ? 107 / 12 : 9);
  close(condition.mean_difference, moved ? 1 / 3 : 0.5);
  const first = receipt.replicates.find(item => item.biological_replicate === "replicate-1");
  const second = receipt.replicates.find(item => item.biological_replicate === "replicate-2");
  assert.equal(first.image_pair_count, moved ? 3 : 2);
  assert.equal(second.image_pair_count, moved ? 2 : 3);
  close(first.before_mean, moved ? 32 / 3 : 6);
  close(first.after_mean, moved ? 34 / 3 : 7);
  close(first.mean_difference, moved ? 2 / 3 : 1);
  close(second.mean_difference, 0);
  const edited = receipt.images.find(item => item.after_result_id === child.id);
  assert.equal(edited.before_count, 2);
  assert.equal(edited.after_count, 1);
  assert.equal(edited.count_difference, -1);
  assert.equal(edited.before_mean, 4);
  assert.equal(edited.after_mean, 6);
  assert.equal(edited.mean_difference, 2);
  assert.equal(edited.correction.changed_voxel_count, 2);
  assert.deepEqual(edited.correction.removed_label_ids, [1]);
}
async function wait(read, accept, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    const alert = page.locator(".research-alert[role=alert], .research-label-import [role=alert]").first();
    if (await alert.isVisible().catch(() => false)) throw new Error(label + ": " + await alert.innerText());
    value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(150);
  }
  throw new Error("No verified completion for " + label + ": " + JSON.stringify(value));
}
async function screenshot(name, target) {
  if (target) await target.scrollIntoViewIfNeeded();
  const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme }));
  assert.ok(bounds.scroll <= bounds.width + 1, "Horizontal document overflow: " + JSON.stringify(bounds));
  await page.screenshot({ path: path.join(runRoot, name + ".png"), fullPage: true });
  checkpoints.push({ name, ...bounds });
  process.stdout.write("Checkpoint: " + name + "\n");
}
async function dialogs(labels = labelsPath(fields[0])) {
  await app.evaluate(({ dialog }, values) => {
    globalThis.lociEffectQaDialogs ??= [];
    const event = (kind, title) => globalThis.lociEffectQaDialogs.push({ kind, title });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      event("open", title);
      const paths = {
        "Add microscopy or medical images": values.sources,
        "Open research study": [values.study],
        "Import labels on this plane": [values.labels],
        "Import portable Loci study": [values.archive],
      };
      const filePaths = paths[title];
      return { canceled: !filePaths, filePaths: filePaths ?? [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      event("save", title);
      const paths = {
        "Save research study as": values.study,
        "Export reviewed experiment effect report": values.export,
        "Export portable study with derived results": values.archive,
        "Choose a new study directory": values.imported,
      };
      const filePath = paths[title];
      return { canceled: !filePath, filePath };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources: fields.map(sourcePath), study: studyPath, labels, export: exportDestination,
    archive: archivePath, imported: importedStudyPath });
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData],
    cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 850 }));
  await dialogs();
}
async function closeOwnedApp() {
  if (!app) return;
  nativeDialogs.push(...await app.evaluate(() => globalThis.lociEffectQaDialogs ?? []));
  await app.close();
  app = undefined;
}
async function selectSource(name) {
  const state = await snapshot();
  const source = state.sources.find(item => item.name === path.basename(sourcePath(name)));
  assert.ok(source, "Exact authored source absent: " + name);
  const row = page.locator(`[data-source-id="${source.id}"]`);
  if (await row.getAttribute("aria-current") !== "true") await row.click();
  await wait(() => row.getAttribute("aria-current"), value => value === "true", "select " + name);
  return source;
}
async function openResult(name, result) {
  await selectSource(name);
  const row = page.locator(`.research-sources [data-result-id="${result.id}"]`);
  if (!(await row.getAttribute("class"))?.includes("selected")) await row.click();
  await wait(() => row.getAttribute("class"), value => value?.includes("selected"), "select exact revision");
}
async function metadata(name, replicate) {
  const source = await selectSource(name);
  const old = (await snapshot()).samples.find(item => item.id === source.id)?.revision ?? 0;
  await selectWorkbenchTool(page, "Info");
  const details = page.getByText("Study metadata", { exact: true }).locator("..");
  if (!(await details.evaluate(element => element.open))) await details.locator(":scope > summary").click();
  for (const [label, value] of [["sample", name], ["condition", "synthetic-condition"], ["biological_replicate", replicate]])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  await wait(snapshot, state => state?.samples?.some(item => item.id === source.id && item.revision > old &&
    item.data.biological_replicate === replicate), "explicit source metadata");
  if (name === fields[4]) {
    await screenshot("metadata-" + replicate + "-grouping", page.getByLabel("sample", { exact: true }));
    await screenshot("metadata-" + replicate + "-save-control", page.getByRole("button", { name: "Save metadata", exact: true }));
  }
}
async function adopt(name, count) {
  const source = await selectSource(name);
  await selectWorkbenchTool(page, "Display");
  const ready = () => page.evaluate(id => {
    const viewer = document.querySelector(`[data-viewer-source="${id}"]`);
    const workspace = document.querySelector("main.image-first-workbench");
    return viewer?.getAttribute("data-prepared") === "true" && workspace?.getAttribute("aria-busy") !== "true" && !workspace?.inert;
  }, source.id);
  await wait(ready, Boolean, "prepared exact source");
  for (const [label, value] of [["X", 0], ["Y", 0], ["Width", 256], ["Height", 256], ["C", 0]])
    await setSelectionField(page, label, value);
  await wait(ready, Boolean, "selected native plane");
  await dialogs(labelsPath(name));
  await selectWorkbenchTool(page, "Analyze");
  await revealExternalLabels(page);
  await page.getByRole("button", { name: "Import labels", exact: true }).click();
  const overlay = page.getByAltText("Checked label overlay on the selected source plane", { exact: true });
  await wait(() => overlay.evaluate(img => img.complete && img.naturalWidth > 0), Boolean, "decoded known-label preview");
  const ids = new Set((await snapshot()).results.map(item => item.id));
  await page.getByRole("button", { name: "Import on this plane", exact: true }).click();
  const state = await wait(snapshot, value => value?.results?.some(item => !ids.has(item.id)), "adopt known labels");
  const added = state.results.filter(item => !ids.has(item.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].object_count, count);
  assert.equal(added[0].source_id, source.id);
  assert.equal(added[0].kind, "external-labels");
  return added[0];
}
async function setReview(result, disposition) {
  await selectWorkbenchTool(page, "Study");
  await page.getByLabel(`Mark ${result.id} ${disposition}`, { exact: true }).click();
  await wait(snapshot, state => state?.results?.some(item => item.id === result.id &&
    item.review?.disposition === disposition), "explicit " + disposition + " review");
}
const panel = () => page.getByRole("region", { name: "Experiment effect", exact: true });
function displayedNumber(value, signed = false) {
  if (value === null) return "—";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const rounded = Number(value.toPrecision(6));
  let text = String(rounded);
  if (Math.abs(rounded) >= 1e6 || Math.abs(rounded) < 1e-4) {
    const [mantissa, exponent] = value.toExponential(5).split("e");
    text = Number(mantissa) + "e" + exponent;
  }
  return signed && value > 0 ? "+" + text : text;
}
const exactNumber = value => value === null ? "undefined" : Object.is(value, -0) ? "-0" : String(value);
async function assertHorizontalFit(locator, label) {
  const geometry = await locator.evaluate(element => {
    const inspector = element.closest(".research-inspector").getBoundingClientRect();
    const nodes = [element, ...element.querySelectorAll("th,td,span")].map(node => {
      const rect = node.getBoundingClientRect();
      return { text: node.textContent, left: rect.left, right: rect.right, width: node.clientWidth, scroll: node.scrollWidth };
    });
    return { inspector: { left: inspector.left, right: inspector.right }, nodes };
  });
  for (const node of geometry.nodes) {
    assert.ok(node.left >= geometry.inspector.left - 1 && node.right <= geometry.inspector.right + 1,
      label + " extends beyond the inspector: " + JSON.stringify(node));
    assert.ok(node.scroll <= node.width + 1, label + " hides or overflows comparison fields: " + JSON.stringify(node));
  }
}
async function assertCompactTable(table, rows, kind) {
  const groups = table.locator("tbody");
  assert.equal(await groups.count(), rows.length);
  for (const [index, row] of rows.entries()) {
    const group = groups.nth(index);
    const label = kind === "condition" ? row.condition : row.biological_replicate + " · " + row.condition;
    assert.equal(await group.getAttribute("aria-label"), label);
    const heading = await group.locator(".correction-effect-row-label").textContent();
    assert.ok(heading.includes(label), "Full comparison label missing");
    assert.ok(heading.includes("Image pairs: " + row.image_pair_count));
    assert.ok(heading.includes("Omitted: " + row.omitted_image_pair_count));
    if (kind === "condition") assert.ok(heading.includes("Biological n: " + row.biological_n));
    assert.deepEqual(await group.locator("tr[data-effect-values] td").allTextContents(), [
      displayedNumber(row.before_mean), displayedNumber(row.after_mean), displayedNumber(row.mean_difference, true),
    ], "Displayed means must follow declared six-significant-digit precision");
  }
  await assertHorizontalFit(table, kind + " comparison");
}
async function assertFullPrecision(rows, kind, unit) {
  await disclosure(kind === "condition" ? "Full precision condition values" : "Full precision biological replicate values");
  for (const row of rows) {
    const label = kind === "condition" ? "condition " + row.condition : "replicate " + row.biological_replicate + " · " + row.condition;
    const detail = panel().getByLabel("Full precision for " + label, { exact: true });
    await detail.waitFor({ state: "visible" });
    assert.ok((await detail.textContent()).includes("Unit: " + unit));
    for (const key of ["before_mean", "after_mean", "mean_difference"])
      assert.equal(await detail.locator(`[data-effect-exact="${key}"]`).textContent(), exactNumber(row[key]), "Exact accessible value differs from stored receipt");
  }
}
async function selectedRevisionDetails(select, result, label) {
  const option = await select.locator("option:checked").textContent();
  assert.equal(await select.inputValue(), result.id);
  const state = await snapshot();
  const sourceName = state.sources.find(source => source.id === result.source_id)?.name;
  assert.ok(sourceName && option.startsWith(sourceName + " · "));
  assert.ok(option.includes(result.method_label ?? (result.kind === "corrected-labels" ? "Corrected segmentation" : "Imported labels")));
  assert.ok(option.includes(` · ${result.object_count} ${result.object_count === 1 ? "object" : "objects"} · Run `));
  assert.ok(!option.includes(result.id.slice(0, 8)), "Internal result ID leaked into the ordinary choice.");
  const detail = panel().getByLabel(label, { exact: true });
  await detail.waitFor({ state: "visible" });
  const text = await detail.textContent();
  const created = detail.locator("time");
  assert.equal(await created.getAttribute("datetime"), result.created_at, "Readable creation time lost its exact timestamp binding");
  assert.ok((await created.textContent()).trim().length > 0, "Readable creation time is empty");
  assert.ok(!text.includes(result.created_at), "Raw timestamp leaked into the routine revision details");
  assert.ok(text.includes(result.review?.disposition ?? "pending review"), "Selected review state is not accessible");
  const technical = panel().getByLabel("Technical record for " + label, { exact: true });
  assert.equal(await technical.evaluate(element => element.open), false);
  assert.ok((await technical.textContent()).includes(result.id));
  assert.ok((await technical.textContent()).includes(result.revision_hash));
  assert.equal(await technical.getByText(result.created_at, { exact: true }).isVisible(), false);
  assert.ok((await technical.textContent()).includes(result.created_at), "Technical record lost the original timestamp");
  await assertHorizontalFit(detail, "selected revision details");
}
async function startEffect(child, parents) {
  await openResult(fields[0], child);
  await selectWorkbenchTool(page, "Correction");
  await page.getByRole("button", { name: "Show experiment effect", exact: true }).click();
  await panel().waitFor({ state: "visible" });
  // A single corrected image is seeded; context requires explicit researcher choice.
  const details = panel().getByText("Unchanged context images", { exact: true }).locator("..");
  if (!(await details.evaluate(element => element.open))) await details.locator(":scope > summary").click();
  for (const [index, result] of parents.slice(1).entries()) {
    const context = panel().getByRole("combobox", { name: `Context revision for ${path.basename(sourcePath(fields[index + 1]))}`, exact: true });
    assert.equal(await context.inputValue(), "", "Context was silently guessed");
    await context.selectOption(result.id);
  }
}
async function calculate(previousHashes = new Set()) {
  await panel().getByRole("button", { name: /^(?:Recalculate|Calculate) experiment effect$/ }).click();
  const state = await wait(snapshot, value => value?.comparisons?.some(item =>
    item.data.receipt.schema === "loci.study-correction-effect/v1" && !previousHashes.has(item.data.receipt.receipt_sha256)), "new canonical effect receipt");
  const documents = state.comparisons.filter(item => item.data.receipt.schema === "loci.study-correction-effect/v1" &&
    !previousHashes.has(item.data.receipt.receipt_sha256));
  assert.equal(documents.length, 1);
  const receipt = documents[0].data.receipt;
  const table = panel().getByRole("table", { name: "Condition experiment effect", exact: true });
  await table.waitFor({ state: "visible" });
  await assertCompactTable(table, receipt.conditions, "condition");
  await assertFullPrecision(receipt.conditions, "condition", receipt.unit);
  return receipt;
}
async function rejectExport(receiptHash, reason) {
  exportDestination = rejectedExportPath;
  await dialogs();
  const response = await page.evaluate(async hash => {
    try { return { succeeded: true, value: await window.lociResearch.exportCorrectionEffect(hash) }; }
    catch (error) { return { succeeded: false, error: String(error) }; }
  }, receiptHash);
  assert.equal(response.succeeded, false, "Backend published invalid report: " + JSON.stringify(response));
  assert.match(response.error, reason);
  assert.equal(await fs.stat(rejectedExportPath).catch(error => { if (error.code === "ENOENT") return null; throw error; }), null);
  records.export_rejections ??= [];
  records.export_rejections.push(response.error);
  exportDestination = exportPath;
  await dialogs();
}
async function disclosure(label) {
  const details = panel().getByText(label, { exact: true }).locator("..");
  if (!(await details.evaluate(element => element.open))) await details.locator(":scope > summary").click();
  return details;
}
async function captureReports(prefix) {
  const state = await snapshot();
  const receiptHash = await panel().getByRole("region", { name: "Experiment effect receipt", exact: true }).getAttribute("data-receipt-sha256");
  const receipt = state.comparisons.find(document => document.data.receipt.receipt_sha256 === receiptHash)?.data.receipt;
  assert.ok(receipt, "Displayed receipt is not an exact saved receipt");
  const selectedChildId = await panel().getByRole("combobox", { name: "After correction revision", exact: true }).inputValue();
  await selectedRevisionDetails(panel().getByRole("combobox", { name: "After correction revision", exact: true }),
    state.results.find(result => result.id === selectedChildId), "Selected correction revision details");
  await screenshot(prefix + "-exact-pair", panel().getByRole("combobox", { name: "After correction revision", exact: true }));
  await disclosure("Unchanged context images");
  for (const name of fields.slice(1)) {
    const sourceName = path.basename(sourcePath(name));
    const select = panel().getByRole("combobox", { name: `Context revision for ${sourceName}`, exact: true });
    const selectedId = await select.inputValue();
    await selectedRevisionDetails(select, state.results.find(result => result.id === selectedId), "Selected context revision details for " + sourceName);
    await screenshot(prefix + "-context-" + name, select);
  }
  const conditions = panel().getByRole("table", { name: "Condition experiment effect", exact: true });
  await assertCompactTable(conditions, receipt.conditions, "condition");
  await screenshot(prefix + "-conditions", panel().getByRole("table", { name: "Condition experiment effect", exact: true }));
  await assertFullPrecision(receipt.conditions, "condition", receipt.unit);
  await screenshot(prefix + "-conditions-full-precision", panel().getByText("Full precision condition values", { exact: true }).locator(".."));
  await disclosure("Biological replicate contributions");
  await assertCompactTable(panel().getByRole("table", { name: "Biological replicate experiment effect", exact: true }), receipt.replicates, "replicate");
  await screenshot(prefix + "-replicates", panel().getByRole("table", { name: "Biological replicate experiment effect", exact: true }));
  await assertFullPrecision(receipt.replicates, "replicate", receipt.unit);
  await screenshot(prefix + "-replicates-full-precision", panel().getByText("Full precision biological replicate values", { exact: true }).locator(".."));
  await disclosure("Image contributions and correction details");
  for (const name of fields) {
    await screenshot(prefix + "-" + name, panel().getByRole("heading", { name: path.basename(sourcePath(name)), exact: true }));
    const image = receipt.images.find(row => row.metadata.sample === name);
    await disclosure("Full precision image values for " + name);
    const detail = panel().getByLabel("Full precision for image " + name, { exact: true });
    for (const key of ["before_mean", "after_mean", "mean_difference"])
      assert.equal(await detail.locator(`[data-effect-exact="${key}"]`).textContent(), exactNumber(image[key]), "Exact image value differs from stored receipt");
    await screenshot(prefix + "-" + name + "-full-precision", detail);
  }
  await screenshot(prefix + "-audit", await disclosure("Correction audit for " + fields[0]));
  const record = panel().getByRole("region", { name: "Experiment effect receipt", exact: true })
    .getByText("Technical record", { exact: true }).locator("..");
  if (!(await record.evaluate(element => element.open))) await record.locator(":scope > summary").click();
  await screenshot(prefix + "-identities", record);
  await screenshot(prefix + "-identities-bottom", record.locator("p").last());
  await screenshot(prefix + "-export-controls", panel().getByRole("button", { name: "Export reviewed effect report", exact: true }));
}
async function restore(receipt) {
  await disclosure("Saved experiment effects");
  const restoreButton = panel().locator(`button[data-report-id="${receipt.receipt_sha256.slice(0, 32)}"]`);
  assert.match(await restoreButton.getAttribute("aria-label"), /^Restore .+ report [1-9][0-9]*$/);
  await restoreButton.click();
  await panel().getByText("Historical snapshot", { exact: false }).waitFor();
}
async function theme(value) {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Application theme", exact: true }).selectOption(value);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await wait(() => page.locator("html").getAttribute("data-theme"), actual => actual === value, "applied real theme");
}

await Promise.all([fs.access(executable), fs.access(worker), fs.access(asar), fs.access(python), fs.mkdir(userData, { recursive: true })]);
const buildBefore = await buildIdentity();
const sourceIdentity = { head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
  working_source_sha256: await workingSourceHash(), status: await git("status", "--porcelain"),
  harness_sha256: await hash(path.join(import.meta.dirname, "correction-effect.qa.mjs")), oracle_sha256: await hash(oracleScript) };
const generated = await run(python, [oracleScript, "create", "--root", fixtureRoot], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const fixtureManifest = JSON.parse(generated.stdout);

try {
  await launch();
  await page.locator("main.image-first-empty").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await wait(snapshot, state => state?.sources?.length === 5, "five distinct authored sources");
  const parents = [];
  for (const [index, name] of fields.entries()) {
    await metadata(name, index < 2 ? "replicate-1" : "replicate-2");
    const result = await adopt(name, fixtureManifest.fields[index].areas.length);
    parents.push(result);
    records.results[name] = { [index === 0 ? "parent" : "context"]: await inspect(result.id) };
  }
  assert.equal(new Set((await snapshot()).sources.map(item => item.sha256)).size, 5);
  await openResult(fields[0], parents[0]);
  await selectWorkbenchTool(page, "Correction");
  await page.getByLabel("Correction label", { exact: true }).selectOption("1");
  const originalIds = new Set((await snapshot()).results.map(item => item.id));
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  const corrected = await wait(snapshot, state => state?.results?.some(item => !originalIds.has(item.id)), "actual immutable delete correction");
  const child = corrected.results.find(item => !originalIds.has(item.id));
  assert.equal(child.parent_id, parents[0].id);
  assert.equal(child.object_count, 1);
  records.results[fields[0]].child = await inspect(child.id);
  assert.deepEqual(await inspect(parents[0].id), records.results[fields[0]].parent);
  assertions.actual_correction_parent_immutable = true;

  await startEffect(child, parents);
  await screenshot("01-explicit-context-controls", panel().getByRole("button", { name: /^(?:Recalculate|Calculate) experiment effect$/ }));
  records.pending_receipt = await calculate();
  receiptOracle(records.pending_receipt, parents, child);
  assert.equal(await panel().getByRole("button", { name: "Export reviewed effect report", exact: true }).isEnabled(), false);
  await captureReports("02-pending-review");
  await rejectExport(records.pending_receipt.receipt_sha256, /review/i);
  assertions.pending_review_inspection_and_export_guard = true;

  for (const result of [...parents, child]) await setReview(result, "reviewed");
  await startEffect(child, parents);
  const hashes = () => snapshot().then(state => new Set(state.comparisons.map(item => item.data.receipt.receipt_sha256)));
  records.baseline_receipt = await calculate(await hashes());
  receiptOracle(records.baseline_receipt, parents, child);
  await setReview(child, "excluded");
  await rejectExport(records.baseline_receipt.receipt_sha256, /review|stale|binding/i);
  await setReview(child, "reviewed");
  await startEffect(child, parents);
  records.baseline_receipt = await calculate(await hashes());
  receiptOracle(records.baseline_receipt, parents, child);
  assertions.changed_review_export_fails_closed = true;
  await captureReports("03-reviewed-baseline");
  const beforeMetadata = await snapshot();
  const arrayBindings = resultBindings(beforeMetadata);
  await metadata(fields[4], "replicate-1");
  const afterMetadata = await snapshot();
  assert.deepEqual(resultBindings(afterMetadata), arrayBindings);
  await rejectExport(records.baseline_receipt.receipt_sha256, /sample|metadata|stale|binding/i);
  await startEffect(child, parents);
  records.final_receipt = await calculate(await hashes());
  receiptOracle(records.final_receipt, parents, child, true);
  assert.notEqual(records.final_receipt.receipt_sha256, records.baseline_receipt.receipt_sha256);
  assert.deepEqual(resultBindings(await snapshot()), arrayBindings);
  assertions.metadata_only_recalculation_no_result_or_array_changes = true;
  assertions.stale_metadata_export_fails_closed = true;

  for (const value of ["graphite", "paper"]) {
    await theme(value);
    for (const width of [1280, 1024]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setBounds({ width, height: 850 }), width);
      await captureReports(`04-${value}-${width}`);
    }
  }
  assertions.actual_theme_and_width_capture_matrix = true;
  assertions.six_significant_digit_display_and_exact_accessible_values = true;
  assertions.all_comparison_fields_fit_inspector_in_graphite_paper_at_1280_1024 = true;
  assertions.selected_revision_timestamps_and_review_states_visible = true;
  await panel().getByRole("button", { name: "Export reviewed effect report", exact: true }).click();
  await wait(() => fs.stat(path.join(exportPath, "manifest.json")).catch(() => null), value => value?.size > 0, "atomic reviewed report publication");
  await fileMenuAction(page, "Save study");
  await wait(() => fs.stat(path.join(studyPath, "study.sqlite3")).catch(() => null), value => value?.size > 0, "Save As exact receipt");
  const saved = await snapshot();
  await closeOwnedApp();
  await launch();
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible" });
  if (await page.locator("main.image-first-empty").isVisible()) await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await wait(snapshot, state => state?.results?.length === 6 && state?.comparisons?.length === saved.comparisons.length, "cold reopen exact revisions and receipts");
  assert.deepEqual(comparisonDocuments(reopened), comparisonDocuments(saved));
  assert.deepEqual(resultBindings(reopened), arrayBindings);
  await selectWorkbenchTool(page, "Study");
  await restore(records.final_receipt);
  await captureReports("05-cold-reopen");
  await selectWorkbenchTool(page, "Portability");
  await page.getByRole("button", { name: "Export portable study", exact: true }).click();
  await wait(() => fs.stat(archivePath).catch(() => null), value => value?.size > 0, "portable study archive");
  await page.getByRole("button", { name: "Import portable study", exact: true }).click();
  const imported = await wait(snapshot, state => state?.sources?.length === 5 &&
    state.sources.every(item => item.locator_state === "relink-required") && state?.comparisons?.length === saved.comparisons.length, "portable receipt import");
  assert.deepEqual(comparisonDocuments(imported), comparisonDocuments(reopened));
  assert.deepEqual(resultBindings(imported), arrayBindings);
  await selectWorkbenchTool(page, "Study");
  await restore(records.final_receipt);
  await captureReports("06-portable-restored");
  assertions.save_as_cold_reopen_and_portable_receipt_exact = true;
  await closeOwnedApp();
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2) + "\n");
  const verified = await run(python, [oracleScript, "verify", "--root", fixtureRoot, "--study", studyPath,
    "--export", exportPath, "--archive", archivePath, "--records", recordsPath], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const oracle = JSON.parse(verified.stdout);
  assert.equal(oracle.status, "passed");
  assertions.independent_image_replicate_condition_and_report_oracle = true;
  assert.deepEqual(await buildIdentity(), buildBefore, "Candidate changed during journey");
  const receipt = { schema: "loci.correction-effect-packaged-qa/v1", status: "passed", started_at: startedAt,
    completed_at: new Date().toISOString(), build: buildBefore, source: sourceIdentity,
    invocation: { command: "node desktop/tests/correction-effect.qa.mjs", app_bundle: appBundle, output_root: runRoot },
    fixture: fixtureManifest, assertions, oracle, checkpoints, studyPath, exportPath, archivePath,
    limitation: "Synthetic macOS software checks only; captures require human visual inspection; no biological validation" };
  await fs.writeFile(path.join(runRoot, "correction-effect-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await fs.writeFile(path.join(runRoot, "native-dialog-events.json"), JSON.stringify(nativeDialogs, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  if (page) {
    await screenshot("failure").catch(() => {});
    await fs.writeFile(path.join(runRoot, "failure-ui.txt"), await page.locator("body").innerText().catch(() => "UI unavailable"));
  }
  await fs.writeFile(path.join(runRoot, "correction-effect-receipt.json"), JSON.stringify({
    schema: "loci.correction-effect-packaged-qa/v1", status: "failed", started_at: startedAt,
    build: buildBefore, source: sourceIdentity, assertions, checkpoints, error: String(error),
  }, null, 2) + "\n");
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2) + "\n");
  const events = nativeDialogs.concat(app ? await app.evaluate(() => globalThis.lociEffectQaDialogs ?? []).catch(() => []) : []);
  await fs.writeFile(path.join(runRoot, "native-dialog-events.json"), JSON.stringify(events, null, 2) + "\n");
  throw error;
} finally {
  await closeOwnedApp().catch(() => {});
}
