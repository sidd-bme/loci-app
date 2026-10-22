import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { selectResultSection, fileMenuAction, revealExternalLabels, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";

// All scientific mutations use visible packaged controls and real native-dialog
// handlers. Snapshots and inspection RPCs are read-only assertion evidence.
// Run only in the lead's serial resource window. Never uses a private fixture.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const desktop = path.join(root, "desktop");
const startedAt = new Date().toISOString();
const started = performance.now();
assert.equal(process.platform, "darwin", "This packaged journey requires macOS");
assert.ok(process.env.LOCI_PACKAGED_APP, "Select an explicit candidate with LOCI_PACKAGED_APP");
const appBundle = await fs.realpath(path.resolve(process.env.LOCI_PACKAGED_APP));
const executable = path.join(appBundle, "Contents/MacOS/Loci");
const worker = path.join(appBundle, "Contents/Resources/loci-engine/loci-engine");
const asar = path.join(appBundle, "Contents/Resources/app.asar");
const python = path.join(root, "engine/.venv/bin/python");
const oracleScript = path.join(root, "scripts/fixtures/external_labels_qa.py");
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(root, ".loci/qa"),
  "external-labels-" + startedAt.replaceAll(/[:.]/g, "-"));
const userData = path.join(runRoot, "user-data");
const fixtureRoot = path.join(runRoot, "synthetic-fixtures");
const studyPath = path.join(runRoot, "external-label-adoption.loci-study");
const exportPath = path.join(runRoot, "reviewed-correction");
const archivePath = path.join(runRoot, "portable-study.zip");
const recordsPath = path.join(runRoot, "inspected-records.json");
const fixture = {
  calibrated: path.join(fixtureRoot, "calibrated-source.ome.tiff"),
  pixel: path.join(fixtureRoot, "pixel-source.tiff"),
  labels: path.join(fixtureRoot, "sparse-original-ids.tiff"),
  empty: path.join(fixtureRoot, "empty-labels.tiff"),
};
const TARGET = 0xffffffff;
const checkpoints = [];
const assertions = {};
const records = {};
let app;
let page;
let firstSessionDialogs = [];

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
async function noUiError(label) {
  const alert = page.locator(".research-alert[role=alert], .research-label-import [role=alert]").first();
  if (await alert.isVisible().catch(() => false)) throw new Error(label + ": " + await alert.innerText());
}
async function wait(read, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await noUiError(label);
    const value = await read();
    if (predicate(value)) return value;
    await page.waitForTimeout(150);
  }
  throw new Error("No verified completion for " + label);
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = id => page.evaluate(result_id => window.lociResearch.execute("result", { result_id, limit: 1000 }), id);
async function screenshot(name) {
  await page.screenshot({ path: path.join(runRoot, name + ".png"), fullPage: true });
  checkpoints.push({ name, elapsed_seconds: (performance.now() - started) / 1000 });
  process.stdout.write("Checkpoint: " + name + "\n");
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData], cwd: desktop, timeout: 120_000 });
  page = await app.firstWindow();
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 850 }));
  await dialogs(fixture.labels);
}
async function dialogs(labels, cancelLabels = false) {
  await app.evaluate(({ dialog }, values) => {
    globalThis.lociExternalQaDialogs ??= [];
    const openReply = (title, result) => {
      globalThis.lociExternalQaDialogs.push({ title, canceled: result.canceled,
        file_names: result.filePaths.map(file => file.split(/[\\/]/).at(-1)) });
      return result;
    };
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title === "Add microscopy or medical images") return openReply(title, { canceled: false, filePaths: values.sources });
      if (title === "Open research study") return openReply(title, { canceled: false, filePaths: [values.study] });
      if (title === "Import labels on this plane") return openReply(title, values.cancel
        ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [values.labels] });
      return openReply(title, { canceled: true, filePaths: [] });
    };
    dialog.showSaveDialog = async (...args) => {
      const paths = {
        "Save research study as": values.study,
        "Export reviewed result bundle": values.export,
        "Export portable study with derived results": values.archive,
      };
      const filePath = paths[args.at(-1)?.title];
      return { canceled: !filePath, filePath };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources: [fixture.calibrated, fixture.pixel], labels, cancel: cancelLabels,
    study: studyPath, export: exportPath, archive: archivePath });
}
async function closeOwnedApp() {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => {});
  await app.close();
  app = undefined;
}
async function sourceNamed(name) {
  const state = await wait(snapshot, value => Array.isArray(value?.sources), "source list available");
  const source = state.sources.find(item => item.name === path.basename(name));
  assert.ok(source, "Registered synthetic source absent: " + path.basename(name));
  const row = page.locator(`button[data-source-id="${source.id}"]`);
  if (await row.getAttribute("aria-current") !== "true") await row.click();
  await wait(() => row.getAttribute("aria-current"), value => value === "true", "activate exact synthetic source");
  return source;
}
async function nativePlane(sourcePath, channel) {
  const source = await sourceNamed(sourcePath);
  await selectWorkbenchTool(page, "Display");
  const readySourceView = async () => {
    const state = await snapshot();
    const ready = await page.evaluate(id => {
      const viewer = document.querySelector(`[data-viewer-source="${id}"]`);
      const workspace = document.querySelector("main.image-first-workbench");
      return viewer?.getAttribute("data-prepared") === "true" &&
        workspace?.getAttribute("aria-busy") !== "true" && !workspace?.inert;
    }, source.id);
    return ready && !state.jobs.some(job => ["queued", "running", "cancelling"].includes(job.state));
  };
  await wait(readySourceView, Boolean, "initial exact source view prepared and idle");
  for (const [label, value] of [["X", 0], ["Y", 0], ["Width", 256], ["Height", 256], ["C", channel]])
    await setSelectionField(page, label, value);
  await wait(readySourceView, Boolean, "selected native source plane prepared and idle");
  // Apply a display gamma through the real control. Independent raw-intensity
  // checks must remain exact despite this visible presentation change.
  const channelDetails = page.locator("details.source-channel").filter({
    has: page.getByRole("checkbox", { name: `Channel ${channel + 1} visible`, exact: true }),
  });
  assert.equal(await channelDetails.count(), 1, "The explicitly selected source channel must have one disclosure");
  // The + control is this direct summary's CSS marker. A descendant summary
  // also matches the nested Histogram & levels disclosure inside the channel.
  if (!(await channelDetails.evaluate(element => element.open))) await channelDetails.locator(":scope > summary").click();
  const gamma = channelDetails.getByLabel(`Channel ${channel + 1} gamma`, { exact: true });
  await gamma.fill("2");
  await gamma.press("Enter");
  assert.equal(await gamma.getAttribute("aria-invalid"), "false");
  await wait(() => page.evaluate(source_id => window.lociResearch.execute("source_view", { source_id }), source.id),
    view => view.state?.channels?.find(item => item.channel === channel)?.gamma === 2,
    "changed display gamma persisted for the exact source channel");
  await wait(readySourceView, Boolean, "gamma-adjusted source view prepared and idle");
  await selectWorkbenchTool(page, "Analyze");
  return source;
}
async function preview() {
  // Adoption opens Statistics & objects. Always route back through the visible
  // analysis tool before asking the native label picker for another preview.
  // Reselecting the already-open tool intentionally covers the same-tool
  // navigation regression: its next busy render must not discard a valid grant.
  await selectWorkbenchTool(page, "Analyze");
  await revealExternalLabels(page);
  await page.getByRole("button", { name: "Import labels", exact: true }).click();
  const overlay = page.getByAltText("Checked label overlay on the selected source plane", { exact: true });
  await wait(() => overlay.isVisible(), Boolean, "checked native label preview");
  await wait(() => overlay.evaluate(img => img.complete && img.naturalWidth > 0), Boolean, "decoded real preview");
  assert.equal(await page.getByRole("button", { name: "Import on this plane", exact: true }).isEnabled(), true);
  await page.getByText("Upstream settings and validation are unknown.", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("Producer name (optional)").inputValue(), "");
  assert.equal(await page.getByLabel("Producer version (optional)").inputValue(), "");
  return overlay;
}
async function adopt(source, count) {
  const before = await snapshot();
  const ids = new Set(before.results.map(result => result.id));
  await page.getByRole("button", { name: "Import on this plane", exact: true }).click();
  const state = await wait(snapshot, next => next.results.some(result => !ids.has(result.id)), "explicit label adoption");
  const added = state.results.filter(result => !ids.has(result.id));
  assert.equal(added.length, 1);
  const result = added[0];
  assert.equal(result.kind, "external-labels");
  assert.equal(result.schema, "loci.research-result/v1");
  assert.equal(result.object_count, count, "Object count must count distinct IDs rather than max label");
  assert.equal(result.source_id, source.id);
  assert.equal(result.source_sha256, source.sha256);
  assert.equal(result.review, null);
  await wait(() => page.locator(`button[data-result-id="${result.id}"]`).getAttribute("class"), value => value?.includes("selected"), "select adopted revision");
  return result;
}
async function openResult(result, sourcePath) {
  await sourceNamed(sourcePath);
  const row = page.locator(`button[data-result-id="${result.id}"]`);
  if (!(await row.getAttribute("class"))?.includes("selected")) await row.click();
  await wait(() => row.getAttribute("class"), value => value?.includes("selected"), "select exact result");
}
function checkOrigin(record, channel, labelFileHash) {
  const origin = record.provenance.external_labels;
  assert.ok(origin, "External input provenance is absent");
  assert.equal(origin.file_sha256, labelFileHash);
  assert.equal(origin.original_dtype, "uint32");
  assert.deepEqual(origin.shape, [256, 256]);
  assert.equal(origin.axes, "YX");
  assert.equal(origin.canonical_dtype, "uint32");
  assert.equal(origin.alignment, "same-native-yx-grid");
  assert.equal(origin.producer, null);
  for (const key of ["upstream_settings", "upstream_model", "upstream_runtime"]) assert.equal(origin[key], null);
  assert.equal(origin.upstream_validation, "unknown");
  assert.equal(origin.measurement_channel.index, channel);
  assert.equal(origin.measurement_channel.basis, "raw-source-channel-values");
  assert.deepEqual(record.provenance.measurement_channels, [channel]);
  assert.equal(record.provenance.measurement_basis, "raw-selected-channel-values-on-result-grid");
  assert.equal(origin.source_sha256, record.result.source_sha256);
  assert.equal(origin.source_selection.c, channel);
  assert.match(origin.labels_sha256, /^[a-f0-9]{64}$/);
}

await Promise.all([fs.access(executable), fs.access(worker), fs.access(asar), fs.access(python), fs.mkdir(userData, { recursive: true })]);
const buildBefore = await buildIdentity();
const sourceIdentity = { head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
  working_source_sha256: await workingSourceHash(), status: await git("status", "--porcelain"),
  harness_sha256: await hash(path.join(import.meta.dirname, "external-label-adoption.qa.mjs")), oracle_sha256: await hash(oracleScript) };
const generated = await run(python, [oracleScript, "create", "--root", fixtureRoot], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const fixtureManifest = JSON.parse(generated.stdout);

try {
  await launch();
  await page.locator("main.image-first-empty").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace", exact: true }).waitFor({ timeout: 60_000 });
  await wait(snapshot, state => state.sources.length === 2, "native source import");
  const calibrated = await nativePlane(fixture.calibrated, 1);
  await dialogs(fixture.labels, true);
  await revealExternalLabels(page);
  await page.getByRole("button", { name: "Import labels", exact: true }).click();
  await wait(() => page.getByRole("button", { name: "Import labels", exact: true }).isEnabled(), Boolean, "cancelled native picker");
  assert.equal((await snapshot()).results.length, 0);
  assert.equal(await page.getByRole("button", { name: "Import on this plane", exact: true }).count(), 0);
  assertions.native_picker_cancellation_publishes_nothing = true;
  await dialogs(fixture.labels);
  await preview();
  const previewPanel = page.getByLabel("Import external labels", { exact: true });
  await previewPanel.getByText("256", { exact: true }).waitFor();
  await previewPanel.getByText("uint32 · 256 × 256 YX", { exact: true }).waitFor();
  await previewPanel.getByText("sparse-original-ids.tiff", { exact: true }).waitFor();
  assert.equal((await snapshot()).results.length, 0, "Preview alone must not publish a result");
  await screenshot("01-checked-native-preview");
  await previewPanel.getByRole("button", { name: "Import on this plane", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("01b-preview-metadata-and-adoption");
  // Changing the captured raw channel invalidates a visible checked grant.
  await selectWorkbenchTool(page, "Display");
  await setSelectionField(page, "C", 0);
  await selectWorkbenchTool(page, "Analyze");
  assert.equal(await page.getByRole("button", { name: "Import on this plane", exact: true }).count(), 0);
  await selectWorkbenchTool(page, "Display");
  await setSelectionField(page, "C", 1);
  await selectWorkbenchTool(page, "Analyze");
  await preview();
  const parent = await adopt(calibrated, 256);
  records.parent = await inspect(parent.id);
  checkOrigin(records.parent, 1, fixtureManifest.sha256[path.basename(fixture.labels)]);
  assert.deepEqual(records.parent.measurements.map(row => row.label), fixtureManifest.ids);
  assertions.preview_requires_explicit_adoption_and_captured_channel = true;

  const pixelSource = await nativePlane(fixture.pixel, 0);
  await preview();
  const pixel = await adopt(pixelSource, 256);
  records.pixel = await inspect(pixel.id);
  checkOrigin(records.pixel, 0, fixtureManifest.sha256[path.basename(fixture.labels)]);
  assert.ok(records.pixel.measurements.every(row => row.measure_unit === "pixel^2"));
  await dialogs(fixture.empty);
  await preview();
  const empty = await adopt(pixelSource, 0);
  records.empty = await inspect(empty.id);
  assert.deepEqual(records.empty.measurements, []);
  await selectWorkbenchTool(page, "Population");
  await page.getByRole("region", { name: "Object population explorer", exact: true }).getByText("0 of 0 objects match.", { exact: true }).waitFor();
  await screenshot("02-empty-population");
  assertions.pixel_units_and_empty_population = true;

  // Removal establishes correction/save/reopen/export dependence on canonical
  // adopted arrays, not the external TIFF's continuing availability.
  assert.equal(await hash(fixture.labels), fixtureManifest.sha256[path.basename(fixture.labels)]);
  await fs.unlink(fixture.labels);
  await openResult(parent, fixture.calibrated);
  await selectWorkbenchTool(page, "Population");
  const panel = page.getByRole("region", { name: "Object population explorer", exact: true });
  await panel.getByText("256 of 256 objects match.", { exact: true }).waitFor();
  const population = await page.evaluate(request => window.lociResearch.execute("population_query", request),
    { result_id: parent.id, revision_hash: parent.revision_hash, x_metric: "measure", y_metric: "voxel_count", limit: 25, plot_limit: 1000 });
  assert.equal(population.total_count, 256);
  assert.equal(population.histogram.counts.reduce((sum, count) => sum + count, 0), 256);
  assert.equal(population.summaries.x.mean, (255 * 12 + 13) * 0.5 / 256);
  assert.deepEqual(population.scatter.points.map(point => point.label).sort((a, b) => a - b), fixtureManifest.ids);
  const chartTarget = panel.locator(`circle[data-point-label="${TARGET}"]`);
  await chartTarget.waitFor({ state: "visible" });
  await chartTarget.focus();
  await chartTarget.press("Enter");
  await panel.getByLabel("Selected population object").getByRole("heading", { name: `Object #${TARGET}`, exact: true }).waitFor();
  assert.equal(await chartTarget.getAttribute("aria-pressed"), "true");
  // The default table pages 25 rows. Select original uint32-max ID on page 11.
  for (let offset = 25; offset <= 250; offset += 25) {
    await panel.getByRole("button", { name: "Next page", exact: true }).click();
    const firstId = fixtureManifest.ids[offset];
    await panel.locator(`tr[data-label="${firstId}"]`).waitFor();
  }
  await panel.locator(`tr[data-label="${TARGET}"] button`).click();
  await panel.getByLabel("Selected population object").getByRole("heading", { name: `Object #${TARGET}`, exact: true }).waitFor();
  await panel.getByRole("button", { name: "Locate selected object", exact: true }).click();
  const located = await page.evaluate(request => window.lociResearch.execute("population_locate", request),
    { result_id: parent.id, revision_hash: parent.revision_hash, label: TARGET });
  const [y, x] = located.point_index;
  assert.ok(y >= 242 && y < 245 && x >= 243 && x < 247, "Located point must be inside independent known target geometry");
  const picked = await page.evaluate(request => window.lociResearch.execute("result_label_at", request),
    { result_id: parent.id, revision_hash: parent.revision_hash, axis: "z", index: 0, u: x, v: y });
  assert.equal(picked.label, TARGET);
  const viewer = page.locator(`[data-viewer-source="${calibrated.id}"]`);
  await wait(() => viewer.evaluate((element, pixel) => {
    const camera = JSON.parse(element.getAttribute("data-camera"));
    const bounds = element.getBoundingClientRect();
    const px = bounds.width / 2 + (pixel[1] + 0.5 - camera.x) * camera.scale;
    const py = bounds.height / 2 + (pixel[0] + 0.5 - camera.y) * camera.scale;
    return element.getAttribute("data-prepared") === "true" && px > 0 && px < bounds.width && py > 0 && py < bounds.height;
  }, [y, x]), Boolean, "Locate exposes the owned target pixel in the prepared viewport");
  // Select another original ID, then use a real image click on the independently
  // known target footprint. This checks image/table linkage after Locate.
  await panel.locator(`tr[data-label="${fixtureManifest.ids[250]}"] button`).click();
  const selected = panel.getByLabel("Selected population object");
  await selected.getByRole("heading", { name: `Object #${fixtureManifest.ids[250]}`, exact: true }).waitFor();
  await wait(() => viewer.getAttribute("data-prepared"), value => value === "true", "prepared source viewport");
  const point = await viewer.evaluate((element, pixel) => {
    const camera = JSON.parse(element.getAttribute("data-camera"));
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2 + (pixel[1] + 0.5 - camera.x) * camera.scale,
      y: bounds.top + bounds.height / 2 + (pixel[0] + 0.5 - camera.y) * camera.scale };
  }, [y, x]);
  await page.mouse.click(point.x, point.y);
  await selected.getByRole("heading", { name: `Object #${TARGET}`, exact: true }).waitFor();
  await screenshot("03-original-id-beyond-first-200");
  await panel.getByRole("button", { name: "Edit selected object", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("03b-selected-object-action");
  await panel.getByRole("button", { name: "Edit selected object", exact: true }).click();
  const correctionLabel = page.getByLabel("Correction label", { exact: true });
  await correctionLabel.waitFor({ state: "visible" });
  await wait(() => correctionLabel.inputValue(), value => value === String(TARGET), "transfer exact selected original ID to correction");
  const beforeDelete = new Set((await snapshot()).results.map(item => item.id));
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  const corrected = await wait(snapshot, state => state.results.some(item => !beforeDelete.has(item.id)), "immutable correction child");
  const child = corrected.results.find(item => !beforeDelete.has(item.id));
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.object_count, 255);
  assert.equal(child.review, null);
  records.child = await inspect(child.id);
  checkOrigin(records.child, 1, fixtureManifest.sha256[path.basename(fixture.labels)]);
  assert.deepEqual(records.child.measurements.map(row => row.label), fixtureManifest.ids.slice(0, -1));
  assert.deepEqual((await inspect(parent.id)), records.parent, "Correction altered the parent scientific record");
  await page.getByRole("button", { name: "Undo revision", exact: true }).click();
  await wait(() => page.locator(`button[data-result-id="${parent.id}"]`).getAttribute("class"), value => value?.includes("selected"), "undo selects parent revision");
  assert.equal((await inspect(parent.id)).result.object_count, 256);
  await page.getByRole("button", { name: "Redo revision", exact: true }).click();
  await wait(() => page.locator(`button[data-result-id="${child.id}"]`).getAttribute("class"), value => value?.includes("selected"), "redo selects correction child");
  await screenshot("04-exact-selected-object-deleted");
  assertions.original_id_paging_locate_and_exact_correction = true;
  assertions.parent_immutable_and_original_input_removal = true;

  await fileMenuAction(page, "Save study");
  await wait(() => fs.stat(path.join(studyPath, "study.sqlite3")).catch(() => null), value => value?.size > 0, "saved study");
  const saved = await wait(snapshot, state => state?.results?.length === 4, "saved study snapshot available");
  firstSessionDialogs = await app.evaluate(() => globalThis.lociExternalQaDialogs ?? []);
  await closeOwnedApp();
  await launch();
  await Promise.race([page.locator("main.image-first-empty").waitFor({ state: "visible" }),
    page.locator("main.image-first-workbench").waitFor({ state: "visible" })]);
  if (await page.locator("main.image-first-empty").isVisible())
    await page.getByRole("button", { name: "Open study", exact: true }).click();
  const reopened = await wait(snapshot, state => state?.results?.length === 4, "cold reopen all four exact revisions");
  for (const result of saved.results) {
    const restored = reopened.results.find(item => item.id === result.id);
    assert.ok(restored);
    assert.equal(restored.revision_hash, result.revision_hash);
    assert.deepEqual(restored.arrays, result.arrays);
  }
  await openResult(child, fixture.calibrated);
  assert.deepEqual(await inspect(parent.id), records.parent);
  assert.deepEqual(await inspect(child.id), records.child);
  await selectWorkbenchTool(page, "Info");
  const resultSections=page.getByRole("group",{name:"Result sections",exact:true});
  assert.equal(await resultSections.getByRole("button",{name:"Review",exact:true}).getAttribute("aria-pressed"),"true",
    "Selecting the exact corrected revision must open Review");
  const review=page.getByRole("region",{name:"Review result",exact:true});
  const summary=review.locator(".research-result-summary-card");
  await summary.waitFor({state:"visible"});
  assert.equal(child.object_count,255,"The synthetic correction preserves 255 original object identities");
  await summary.getByText("Summary of the first 200 of 255 objects. Use Statistics & objects for the full population.",{exact:true}).waitFor();
  assert.match(await summary.innerText(),/um\^2/,"Review summary retains the calibrated area unit");
  assert.equal(await review.getByRole("button",{name:"Explore in Statistics & objects",exact:true}).isVisible(),true);
  assert.equal(await page.getByRole("region",{name:"Export scientific data",exact:true}).count(),0);
  assert.equal(await summary.locator("details.research-preview-rows").evaluate(element=>element.open),false);
  for(const name of ["Technical identity","Analysis details","Review history"])
    assert.equal(await review.getByText(name,{exact:true}).evaluate(element=>element.closest("details").open),false);
  const technical=review.locator("details.research-result-details");
  assert.equal(await technical.getByText(child.revision_hash,{exact:true}).count(),1);
  const reviewStatus=page.getByRole("status").filter({hasText:/Review required before export|Review pending/});
  assert.equal((await reviewStatus.locator("..").innerText()).includes(child.revision_hash.slice(0,8)),false);
  await screenshot("05a-review-first-partial-calibrated-preview");
  assertions.review_first_summary_partial_coverage_units_collapsed_details=true;
  await selectResultSection(page, "Export");
  assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), false,
    "Correction child must be explicitly reviewed before export");
  await selectResultSection(page, "Review"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await wait(snapshot, state => state?.results?.find(item => item.id === child.id)?.review?.disposition === "reviewed", "explicit reopened child review");
  await selectResultSection(page, "Export"); await page.getByRole("button", { name: "Export result", exact: true }).click();
  await wait(() => fs.stat(path.join(exportPath, "manifest.json")).catch(() => null), value => value?.size > 0, "atomic reviewed export");
  await screenshot("05-cold-reopen-review-export");
  await selectWorkbenchTool(page, "Portability");
  await page.getByRole("button", { name: "Export portable study", exact: true }).click();
  await wait(() => fs.stat(archivePath).catch(() => null), value => value?.size > 0, "portable study publication");
  records.snapshot = await wait(snapshot, state => state?.results?.length === 4, "exported study snapshot available");
  const nativeDialogs = firstSessionDialogs.concat(await app.evaluate(() => globalThis.lociExternalQaDialogs ?? []));
  await fs.writeFile(path.join(runRoot, "native-dialog-events.json"), JSON.stringify(nativeDialogs, null, 2) + "\n");
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2) + "\n");
  await closeOwnedApp();
  // A separate existing Python process reads TIFF/NPY/CSV and SQLite/ZIP records
  // against fixture equations, without importing the Loci engine.
  const verified = await run(python, [oracleScript, "verify", "--root", fixtureRoot, "--study", studyPath,
    "--export", exportPath, "--archive", archivePath, "--records", recordsPath], { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const oracle = JSON.parse(verified.stdout);
  assert.equal(oracle.status, "passed");
  assertions.cold_reopen_explicit_review_export_and_portability = true;
  assertions.independent_tiff_npy_csv_numerical_and_privacy_checks = true;
  assertions.raw_measurements_ignore_changed_display_gamma = true;
  assert.deepEqual(await buildIdentity(), buildBefore, "Candidate identity changed during journey");
  const report = { schema: "loci.external-label-adoption-packaged-qa/v1", status: "passed", started_at: startedAt,
    timing: { started_at: startedAt, elapsed_seconds: (performance.now() - started) / 1000, checkpoints },
    build: buildBefore, source: sourceIdentity, invocation: { command: "node desktop/tests/external-label-adoption.qa.mjs",
      app_bundle: appBundle, output_root: runRoot, fixture_runtime: python },
    fixture: fixtureManifest, assertions, oracle, studyPath, exportPath, archivePath,
    limitation: "Synthetic macOS technical qualification only; no biological accuracy or cross-platform claim" };
  await fs.writeFile(path.join(runRoot, "external-label-adoption-receipt.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  if (page) {
    await screenshot("failure").catch(() => {});
    await fs.writeFile(path.join(runRoot, "failure-ui.txt"), await page.locator("body").innerText().catch(() => "UI unavailable"));
    const nativeDialogs = await app?.evaluate(() => globalThis.lociExternalQaDialogs ?? []).catch(() => []);
    await fs.writeFile(path.join(runRoot, "native-dialog-events.json"), JSON.stringify(firstSessionDialogs.concat(nativeDialogs ?? []), null, 2) + "\n");
  }
  await fs.writeFile(path.join(runRoot, "external-label-adoption-receipt.json"), JSON.stringify({
    schema: "loci.external-label-adoption-packaged-qa/v1", status: "failed", started_at: startedAt,
    build: buildBefore, source: sourceIdentity, assertions, error: String(error), checkpoints,
  }, null, 2) + "\n");
  throw error;
} finally {
  await closeOwnedApp().catch(() => {});
}
