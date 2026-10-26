/** Packaged palette TIFF journey. Run serially; this script owns its launched app only.
 * LOCI_PACKAGED_APP=/absolute/Loci.app LOCI_QA_OUTPUT_ROOT=/absolute/evidence \
 * LOCI_QA_REFERENCE_PYTHON=/absolute/locked/python node tests/palette-tiff.qa.mjs
 * Optional LOCI_PALETTE_SOURCE plus LOCI_PALETTE_SOURCE_SHA256 pins an authorized red/green palette stack.
 * Synthetic pixels are software oracles, never biological/clinical qualification.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { closeWithConfirmedQuit, researchSourceButtonSelector } from "./public-hardening-qa-helpers.mjs";
import { fileMenuAction, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
assert.equal(process.platform, "darwin", "This journey requires the supported packaged macOS app.");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use the documented Node 24 runtime.");
assert.ok(bundle && path.isAbsolute(bundle), "Set LOCI_PACKAGED_APP to the exact candidate bundle.");
const output = process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repository, ".loci/evidence/qa/palette-tiff");
assert.ok(path.isAbsolute(output), "LOCI_QA_OUTPUT_ROOT must be absolute.");
const relativeOutput = path.relative(repository, output);
assert.ok(relativeOutput.startsWith(`..${path.sep}`) || relativeOutput.startsWith(`.loci${path.sep}`),
  "Keep generated evidence outside Git or under ignored .loci/.");
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(repository, "engine/.venv/bin/python");
assert.ok(path.isAbsolute(python), "LOCI_QA_REFERENCE_PYTHON must be absolute.");
const generator = path.join(repository, "scripts/qa/prepare-palette-fixture.py");
const authorizedSha = process.env.LOCI_PALETTE_SOURCE_SHA256 ?? null;
const realSource = process.env.LOCI_PALETTE_SOURCE ?? null;
assert.ok(realSource === null || path.isAbsolute(realSource),
  "LOCI_PALETTE_SOURCE must explicitly name the authorized palette TIFF with an absolute path.");
if (realSource) assert.match(authorizedSha ?? "", /^[a-f0-9]{64}$/, "Pin LOCI_PALETTE_SOURCE_SHA256 before reading the authorized source.");
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, "palette-"));
await fs.chmod(runRoot, 0o700);
const screenshots = path.join(runRoot, "screenshots-private");
await fs.mkdir(screenshots, { mode: 0o700 });
const fixtureDirectory = path.join(runRoot, "synthetic");
const fixture = path.join(fixtureDirectory, "synthetic-palette-cz.ome.tiff");
const study = path.join(runRoot, "palette.loci-study");
const exported = path.join(runRoot, "synthetic-c1-z2.tiff");
const executable = path.join(bundle, "Contents/MacOS/Loci");
const resources = path.join(bundle, "Contents/Resources");
const sourcePaths = [fixture, ...(realSource ? [realSource] : [])];
const before = new Map();
const errors = [], consoleErrors = [], network = [];
const report = {
  schema: "loci.packaged-palette-qa/v1", status: "running", stages: [], captures: [],
  scope: "Synthetic packaged software regression; optional bounded authorized real-source journey",
  exclusions: ["No biological accuracy claim", "No binary release qualification", "No ordinary native manual GUI claim"],
  real_source_requested: Boolean(realSource),
};
let app = null, page = null, failure = null, stage = "preflight";

async function sha(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function safeError(error) {
  const message = String(error?.stack ?? error);
  return realSource ? message.replaceAll(realSource, "<authorized-palette-source>") : message;
}
async function noUiError() {
  const alert = page.locator('.research-alert[role="alert"]');
  if (await alert.isVisible()) throw new Error(`${stage}: ${await alert.textContent()}`);
}
async function poll(check, label, timeout = 60_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await noUiError();
    const result = await check();
    if (result) return result;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function capture(name) {
  const file = path.join(screenshots, `${name}.png`);
  const bytes = await page.screenshot({ path: file });
  await fs.chmod(file, 0o600);
  report.captures.push({ file: path.basename(file), sha256: createHash("sha256").update(bytes).digest("hex") });
}
async function launch(label) {
  app = await electron.launch({ executablePath: executable,
    args: [`--user-data-dir=${path.join(runRoot, `user-data-${label}`)}`],
    cwd: path.join(repository, "desktop"), timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ BrowserWindow, dialog }, targets) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 40, width: 1440, height: 1000 });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title === "Add microscopy or medical images") return { canceled: false, filePaths: targets.sources };
      if (title === "Open research study") return { canceled: false, filePaths: [targets.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => ({ canceled: false,
      filePath: args.at(-1)?.title === "Save research study as" ? targets.study : targets.exported });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources: sourcePaths, study, exported });
}
async function choose(source) {
  await page.locator(`${researchSourceButtonSelector}[data-source-id="${source.id}"]`).click();
  await selectWorkbenchTool(page, "Display");
  await poll(() => page.locator(`.image-viewport[data-viewer-source="${source.id}"]`)
    .evaluate(element => element.dataset.prepared === "true"), "prepared source canvas");
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
}
const panel = () => page.locator(".source-display");
async function setPlane(source, c, z) {
  // Both the compact toolbar and full display panel have this accessible name.
  // Scope to the full display panel and retain the native combobox role.
  await panel().getByRole("combobox", { name: "Image channel", exact: true }).selectOption(String(c));
  await panel().getByRole("slider", { name: "Z plane", exact: true }).fill(String(z));
  await poll(() => page.locator(`.image-viewport[data-viewer-source="${source.id}"]`)
    .evaluate(element => element.dataset.prepared === "true"), "selected plane readiness");
  return savedView(source, c, z);
}
async function savedView(source, c, z, expectedTone = null) {
  return poll(async () => {
    const saved = await page.evaluate(id => window.lociResearch.execute("source_view", { source_id: id }), source.id);
    const state = saved.state;
    if (!state || state.selection.c !== c || state.selection.z !== z || state.channels.length !== 1 ||
      state.channels[0].channel !== c) return null;
    if (expectedTone && Object.entries(expectedTone).some(([key, value]) => state.channels[0][key] !== value)) return null;
    assert.equal(saved.source_sha256, source.sha256);
    assert.equal(state.projection, "plane");
    assert.equal(state.channels[0].visible, true);
    return saved;
  }, "one selected C mapping saved with the current Z");
}
async function canvas(source, expected = null) {
  const selector = `.image-viewport[data-viewer-source="${source.id}"]`;
  await page.waitForFunction(({ selector, expected }) => {
    const viewport = document.querySelector(selector), image = viewport?.querySelector("canvas");
    if (viewport?.dataset.prepared !== "true" || !image?.width || !image.height) return false;
    const centre = image.getContext("2d").getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return expected === null || expected.every((value, index) => Math.abs(value - centre[index]) <= 1);
  }, { selector, expected }, { timeout: 60_000 });
  return page.locator(`${selector} canvas`).first().evaluate(async image => {
    const data = image.getContext("2d").getImageData(0, 0, image.width, image.height).data;
    const offset = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    const dominance = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++)
      dominance[c] += Math.max(0, data[i + c] - Math.max(data[i + (c + 1) % 3], data[i + (c + 2) % 3]));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return { width: image.width, height: image.height,
      centre_rgb: [...data.slice(offset, offset + 3)], component_dominance: dominance,
      rgba_sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
  });
}
async function histogram(source, c, z, synthetic) {
  const disclosure = panel().locator("details.source-histogram-disclosure");
  if (!await disclosure.evaluate(element => element.open)) await disclosure.locator(":scope > summary").click();
  await panel().getByRole("img", { name: "RGB tone histogram", exact: true }).waitFor();
  await panel().locator(".source-histogram-basis").filter({ hasText: `C ${c + 1}, Z ${z + 1}, T 1` }).waitFor();
  // This independent contract read follows the UI request to avoid superseding
  // its histogram lane. The visible C/Z basis above proves the UI binding too.
  const value = await page.evaluate(({ id, c, z }) => window.lociResearch.execute("viewer_histogram",
    { source_id: id, c, z, t: 0, bins: 256 }), { id: source.id, c, z });
  assert.equal(value.source_sha256, source.sha256);
  assert.equal(value.sample.c, c); assert.equal(value.sample.z, z);
  assert.equal(value.sample.viewport_dependent, false);
  assert.equal(value.histograms.length, 3);
  assert.ok(value.histograms.every(record => record.dtype === "uint16"));
  if (synthetic) for (const record of value.histograms) {
    assert.equal(record.min, record.component === c ? 1 : 0);
    assert.equal(record.max, record.component === c ? 65535 : 0);
  }
  return { sample: value.sample, records: value.histograms.map(({ component, min, max, dtype, sample_count }) =>
    ({ component, min, max, dtype, sample_count })) };
}
async function number(label, value) {
  const input = panel().getByLabel(label, { exact: true });
  await input.fill(String(value)); await input.press("Tab");
  assert.notEqual(await input.getAttribute("aria-invalid"), "true");
}

try {
  await Promise.all([fs.access(executable), fs.access(path.join(resources, "app.asar")), fs.access(python)]);
  const generated = await run(python, [generator, fixtureDirectory], { maxBuffer: 1024 * 1024 });
  const reference = JSON.parse(generated.stdout);
  for (const file of sourcePaths) {
    const info = await fs.lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "Each selected source must be a plain immutable file.");
    before.set(file, { sha256: await sha(file), size: info.size, mtimeMs: info.mtimeMs });
  }
  assert.equal(before.get(fixture).sha256, reference.source_sha256);
  if (realSource) assert.equal(before.get(realSource).sha256, authorizedSha, "Authorized source identity changed.");
  const embedded = JSON.parse(await fs.readFile(path.join(resources, "loci-build-identity.json"), "utf8"));
  assert.equal(embedded.sourceDirty, false, "Use a package built from a recorded clean candidate.");
  if (process.env.LOCI_QA_SOURCE_COMMIT) assert.equal(embedded.sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);
  report.embedded_build_identity = embedded;
  report.identity = {
    checkout_head: (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
    checkout_tree: (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository })).stdout.trim(),
    checkout_status: (await run("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim(),
    executable_sha256: await sha(executable), asar_sha256: await sha(path.join(resources, "app.asar")),
    worker_sha256: await sha(path.join(resources, "loci-engine/loci-engine")),
    harness_sha256: await sha(import.meta.filename), fixture_generator_sha256: await sha(generator),
    node: process.versions.node, architecture: process.arch,
  };
  report.fixture = reference;
  stage = "open synthetic and optional authorized source";
  await launch("initial");
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const snapshot = await waitForSnapshot(page, value => value?.sources?.length === sourcePaths.length,
    "registered palette sources", 120_000);
  const synthetic = snapshot.sources.find(source => source.name === path.basename(fixture));
  assert.ok(synthetic); assert.equal(synthetic.sha256, reference.source_sha256);
  assert.deepEqual(synthetic.metadata.shape, [1, 2, 3, 160, 1280, 3]);
  assert.deepEqual(synthetic.metadata.channel_dtypes, ["uint16", "uint16"]);
  assert.equal(synthetic.metadata.palette.stored_index_dtype, "uint8");
  await choose(synthetic);
  for (const [c, z] of [[0, 0], [1, 0], [1, 1], [0, 2], [1, 2]]) {
    stage = `synthetic C${c} Z${z}`;
    const saved = await setPlane(synthetic, c, z);
    const expected = [0, 0, 0]; expected[c] = reference.centre_canvas_codes[z];
    report.stages.push({ stage, canvas: await canvas(synthetic, expected),
      histogram: await histogram(synthetic, c, z, true), saved_channels: saved.state.channels });
  }
  stage = "synthetic Auto native precision and RGB gamma";
  await number("RGB white point", 60000);
  await panel().getByRole("button", { name: "Auto", exact: true }).click();
  await poll(async () => Number(await panel().getByLabel("RGB white point", { exact: true }).inputValue()) === 65535,
    "Auto white point in uint16 units");
  assert.equal(Number(await panel().getByLabel("RGB black point", { exact: true }).inputValue()), 0);
  await number("RGB gamma", 2);
  const adjusted = [0, Math.round(Math.sqrt(reference.centre_codes[2] / 65535) * 65535 / 257), 0];
  const gammaCanvas = await canvas(synthetic, adjusted);
  await panel().getByRole("button", { name: "Reset", exact: true }).click();
  await poll(async () => Number(await panel().getByLabel("RGB gamma", { exact: true }).inputValue()) === 1,
    "neutral gamma restored");
  await canvas(synthetic, [0, reference.centre_canvas_codes[2], 0]);
  const syntheticSaved = await savedView(synthetic, 1, 2, { low: 0, high: 65535, gamma: 1 });
  assert.equal(syntheticSaved.state.channels[0].high, 65535);
  assert.equal(syntheticSaved.state.channels[0].gamma, 1);
  report.stages.push({ stage, auto: reference.auto, gamma_two_canvas: gammaCanvas });
  await capture("synthetic-c1-z2");

  stage = "synthetic exact rendered TIFF export";
  const exportPanel = page.locator("details.source-export");
  if (!await exportPanel.evaluate(element => element.open)) await exportPanel.locator(":scope > summary").click();
  await page.getByLabel("Rendered export format", { exact: true }).selectOption("tiff");
  await page.getByLabel("Rendered export extent", { exact: true }).selectOption("whole");
  await page.getByRole("button", { name: "Export TIFF16…", exact: true }).click();
  await exportPanel.getByRole("status").filter({ hasText: path.basename(exported) }).waitFor({ timeout: 60_000 });
  const verified = await run(python, [generator, fixtureDirectory, "--verify-export", exported,
    "--channel", "1", "--z", "2"], { maxBuffer: 1024 * 1024 });
  report.export = JSON.parse(verified.stdout);

  stage = "scalar analysis refusal through packaged IPC";
  const refusal = await page.evaluate(async id => {
    const before = await window.lociResearch.getSnapshot();
    let rejected = false, message = "";
    try {
      await window.lociResearch.execute("run_recipe", { source_id: id,
        selection: { x: 0, y: 0, width: 8, height: 8, c: 1, z: 2, t: 0, level: 0 },
        recipe: { segmentation: { method: "components", threshold: 1 } } });
    } catch (error) { rejected = true; message = String(error); }
    const after = await window.lociResearch.getSnapshot();
    return { rejected, message, results_before: before.results.map(result => result.id),
      results_after: after.results.map(result => result.id) };
  }, synthetic.id);
  assert.equal(refusal.rejected, true);
  assert.match(refusal.message, /RGB samples.*biological channels/i);
  assert.deepEqual(refusal.results_after, refusal.results_before);
  report.scalar_refusal = refusal;

  let real = null, realSaved = null, realCanvas = null;
  if (realSource) {
    stage = "authorized real source C0 C1 and Z navigation";
    real = snapshot.sources.find(source => source.name === path.basename(realSource));
    assert.ok(real); assert.equal(real.sha256, authorizedSha);
    assert.equal(real.metadata.palette.lookup_policy, "actual-IFD-ColorMap");
    await choose(real);
    const z = Math.floor(real.metadata.dimensions.z / 2);
    // The authorized stack's first C0 plane is entirely black. Compare the
    // populated central plane; a valid empty plane cannot prove color dominance.
    await setPlane(real, 0, z);
    const c0 = await canvas(real);
    await setPlane(real, 1, z);
    const c1 = await canvas(real);
    report.real_source = { source_sha256: real.sha256, compared_z: z, c0_canvas: c0, c1_canvas: c1 };
    assert.notEqual(c0.rgba_sha256, c1.rgba_sha256, "C change must change actual rendered pixels.");
    assert.ok(c0.component_dominance[0] > c0.component_dominance[1]);
    assert.ok(c1.component_dominance[1] > c1.component_dominance[0]);
    realSaved = await setPlane(real, 1, z);
    realCanvas = await canvas(real);
    report.real_source = { source_sha256: real.sha256, selection: realSaved.state.selection,
      c0_canvas: c0, c1_canvas: c1, selected_canvas: realCanvas,
      histogram: await histogram(real, 1, z, false) };
    await capture("authorized-source-c1-z-mid");
  }
  stage = "save study and terminate first app process";
  await fileMenuAction(page, "Save as study…");
  await poll(() => fs.access(path.join(study, "study.sqlite3")).then(() => true, () => false), "saved study database");
  await closeWithConfirmedQuit(app); app = null; page = null;
  stage = "cold app launch and explicit saved study reopen";
  await launch("cold");
  await fileMenuAction(page, "Open study");
  await waitForSnapshot(page, value => value?.sources?.length === sourcePaths.length, "cold reopened sources", 120_000);
  const cold = [];
  for (const [source, saved, expected] of [[synthetic, syntheticSaved, [0, reference.centre_canvas_codes[2], 0]],
    ...(real ? [[real, realSaved, null]] : [])]) {
    await choose(source);
    assert.equal(await panel().getByRole("combobox", { name: "Image channel", exact: true }).inputValue(), String(saved.state.selection.c));
    assert.equal(await panel().getByRole("slider", { name: "Z plane", exact: true }).inputValue(), String(saved.state.selection.z));
    const reopened = await savedView(source, saved.state.selection.c, saved.state.selection.z);
    assert.deepEqual(reopened.state.channels, saved.state.channels);
    const visible = await canvas(source, expected);
    if (source === real) assert.ok(visible.component_dominance[1] > visible.component_dominance[0]);
    cold.push({ source_sha256: source.sha256, selection: reopened.state.selection,
      channels: reopened.state.channels, canvas: visible });
    await capture(source === synthetic ? "cold-synthetic-c1-z2" : "cold-authorized-source-c1-z-mid");
  }
  report.cold_reopen = cold;
  await noUiError();
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(network, []);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) await capture("failure").catch(() => {});
} finally {
  if (app) {
    try { await closeWithConfirmedQuit(app); }
    catch (error) { report.close_error = safeError(error); failure ??= error; }
  }
  report.source_integrity = [];
  for (const [file, original] of before) {
    try {
      const current = await fs.stat(file);
      const digest = await sha(file);
      assert.equal(digest, original.sha256, "Original source bytes changed.");
      assert.equal(current.size, original.size); assert.equal(current.mtimeMs, original.mtimeMs);
      report.source_integrity.push({ source_sha256: digest, size_bytes: current.size, unchanged: true });
    } catch (error) { failure ??= error; report.source_integrity.push({ source_sha256: original.sha256, unchanged: false }); }
  }
  report.status = failure ? "failed" : "passed";
  report.last_stage = stage;
  if (failure) report.failure = safeError(failure);
  report.renderer_errors = errors; report.console_errors = consoleErrors; report.network_requests = network;
  await fs.writeFile(path.join(runRoot, "qa-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (failure) throw failure;
console.log(JSON.stringify({ status: report.status, runRoot, identity: report.identity }));
