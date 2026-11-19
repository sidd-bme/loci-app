/** Exercise the offline standalone μSAM handoff on generated data through the packaged UI and CLI. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { revealExternalLabels, selectWorkbenchTool, setSelectionField, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const appPath = await fs.realpath(process.env.LOCI_PACKAGED_APP);
const contents = path.join(appPath, "Contents");
const identity = JSON.parse(await fs.readFile(path.join(contents, "Resources/loci-build-identity.json"), "utf8"));
assert.equal(identity.sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);
assert.equal(identity.sourceDirty, false);
assert.ok(path.isAbsolute(process.env.LOCI_QA_OUTPUT_ROOT));
await fs.mkdir(process.env.LOCI_QA_OUTPUT_ROOT, { recursive: true });
const output = await fs.mkdtemp(path.join(process.env.LOCI_QA_OUTPUT_ROOT, "microsam-"));
const study = path.join(output, "Interchange.loci-study");
const planeFolder = path.join(output, "plane-handoff");
const volumeFolder = path.join(output, "volume-handoff");
const environment = { ...process.env, LOCI_MODEL_HOME: path.join(output, "empty-model-home") };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.PYTHONPATH;
const options = { cwd: output, env: environment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 };
const localCli = path.join(contents, "Resources/bin/loci");
const fixtureScript = path.join(repo, "scripts/fixtures/handoff_fixture.py");
const fixturePython = process.env.LOCI_QA_PYTHON ?? path.join(repo, "engine/.venv/bin/python");
const json = async (program, args) => JSON.parse((await exec(program, args, options)).stdout);
const cli = (command, args = []) => json(localCli, [command, "--project", study, ...args, "--json"]);
const oracle = (...args) => json(fixturePython, [fixtureScript, ...args]);
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const sha = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const receipt = { identity, status: "running", checks: [], numerics: {}, started_at: new Date().toISOString() };
let app;
async function close() {
  if (!app) return;
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); }).catch(() => {});
  await app.close();
  app = undefined;
}
async function checkBundle(folder, fixture, selection) {
  assert.deepEqual((await fs.readdir(folder)).sort(), ["README.md", "input.tif", "manifest.json"]);
  const manifest = await read(path.join(folder, "manifest.json"));
  assert.equal(manifest.schema, "loci.usam-handoff/v1");
  assert.equal(manifest.source_sha256, fixture.sha256);
  assert.deepEqual(manifest.selection, selection);
  assert.equal(manifest.validation, "not-established");
  assert.ok(!JSON.stringify(manifest).includes(output));
  const raw = await oracle("input", path.join(folder, "input.tif"), JSON.stringify(selection));
  assert.equal(raw.sha256, manifest.input.file_sha256);
  assert.deepEqual(raw.shape, manifest.input.shape);
  assert.equal(raw.dtype, manifest.input.dtype);
  assert.equal(raw.axes, manifest.input.axes);
  return manifest;
}
async function checkAdoption(id, selection, manifest, label, fixture) {
  const inspection = await cli("execute", ["result", "--request", JSON.stringify({ result_id: id })]);
  const ext = inspection.provenance.external_labels;
  assert.equal(ext.handoff.handoff_id, manifest.handoff_id);
  assert.equal(ext.handoff.manifest_sha256, manifest.manifest_sha256);
  assert.equal(ext.handoff.exported_input_file_sha256, manifest.input.file_sha256);
  assert.equal(ext.handoff.mask_origin_verified_by_loci, false);
  assert.equal(ext.upstream_validation, "unknown");
  assert.equal(ext.producer_identity_basis, "user-declared");
  assert.equal(ext.producer.model, "synthetic-test-declaration");
  assert.equal(ext.file_sha256, fixture.labels[label].sha256);
  assert.equal(inspection.result.object_count, 2);
  assert.equal(inspection.result.review, null);
  const recordFile = path.join(output, label + "-inspection.json");
  await fs.writeFile(recordFile, JSON.stringify(inspection));
  receipt.numerics[label] = await oracle("result", study, recordFile, JSON.stringify(selection));
  return inspection.result;
}
try {
  const fixture = await oracle("generate", output);
  const selection = { x: 0, y: 0, width: fixture.width, height: fixture.height, t: 0, c: 0, z: 0, level: 0 };
  await cli("create", ["--title", "Synthetic label interchange"]);
  const source = (await cli("import", [fixture.source])).sources[0];
  assert.equal(source.sha256, fixture.sha256);
  app = await electron.launch({ executablePath: path.join(contents, "MacOS/Loci"),
    args: ["--user-data-dir=" + path.join(output, "profile")], env: environment, timeout: 120_000 });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async (...args) => {
      const file = files.open[args.at(-1)?.title];
      return { canceled: !file, filePaths: file ? [file] : [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const file = files.save[args.at(-1)?.title];
      return { canceled: !file, filePath: file };
    };
  }, { open: { "Open research study": study, "Select μSAM handoff manifest.json": path.join(planeFolder, "manifest.json"),
      "Import labels on this plane": fixture.labels.YX.file }, save: { "Export native TIFF for μSAM": planeFolder } });
  const button = name => page.getByRole("button", { name, exact: true });
  await button("Open study").click();
  await waitForSnapshot(page, state => state?.sources?.some(item => item.id === source.id), "synthetic source");
  await page.locator('button[data-source-id="' + source.id + '"]').click();
  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of [["X", 0], ["Y", 0], ["Width", fixture.width], ["Height", fixture.height], ["C", 0], ["Z", 0], ["T", 0]]) {
    await setSelectionField(page, label, value);
  }
  await selectWorkbenchTool(page, "Analyze");
  await revealExternalLabels(page);
  await page.locator("summary").filter({ hasText: "μSAM (standalone)" }).click();
  await button("Export native TIFF for μSAM").click();
  await page.getByText("plane-handoff", { exact: true }).waitFor();
  const plane = await checkBundle(planeFolder, fixture, selection);
  await button("Return labels with manifest…").click();
  const overlay = page.getByAltText("Checked label overlay on the selected source plane");
  await overlay.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector("img.research-label-import-preview");
    return image?.complete && image.naturalWidth > 0;
  });
  const preview = await overlay.evaluate(image => {
    image.scrollIntoView({ block: "center", behavior: "instant" });
    const box = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    return { width: box.width, height: box.height, pixelsWide: image.naturalWidth,
      pixelsHigh: image.naturalHeight, sampling: style.imageRendering, fit: style.objectFit };
  });
  assert.deepEqual([preview.pixelsWide, preview.pixelsHigh], [fixture.width, fixture.height]);
  assert.ok(Math.min(preview.width / preview.pixelsWide, preview.height / preview.pixelsHigh) >= 4,
    "A small returned mask must be large enough to inspect before adoption");
  assert.equal(preview.sampling, "pixelated");
  assert.equal(preview.fit, "contain");
  receipt.plane_preview = preview;
  await page.screenshot({ path: path.join(output, "checked-plane.png") });
  assert.equal((await cli("results")).results.length, 0);
  const fields = page.getByLabel("Model (optional)", { exact: true });
  if (!await fields.isVisible()) await page.locator("summary").filter({ hasText: "External model details" }).click();
  await page.getByLabel("Producer name (optional)").fill("Authored QA labels");
  await fields.fill("synthetic-test-declaration");
  await button("Import on this plane").click();
  const adopted = await waitForSnapshot(page, state => state?.results?.length === 1, "adopted plane");
  await close();
  const planeResult = await checkAdoption(adopted.results[0].id, selection, plane, "YX", fixture);
  receipt.checks.push("Native UI exported raw YX and adopted a previewed sparse label plane through its saved manifest");
  const volume = { ...selection, t: 1, c: 1, z: 1, z_stop: 4 };
  const binding = ["--source", source.id, "--source-sha256", fixture.sha256];
  const args = [...binding, "--selection", JSON.stringify(volume)];
  const exported = await cli("usam-handoff", [...args, "--destination", volumeFolder]);
  const stack = await checkBundle(volumeFolder, fixture, volume);
  assert.equal(exported.handoff_id, stack.handoff_id);
  await assert.rejects(() => cli("usam-handoff", [...args, "--destination", volumeFolder]), /already exists/i);
  const labels = ["--path", fixture.labels.ZYX.file, "--handoff-id", stack.handoff_id];
  await assert.rejects(() => cli("import-labels", [...binding, "--selection", JSON.stringify({ ...volume, t: 0 }), ...labels]),
    /different native|different.*range|does not match/i);
  await assert.rejects(() => cli("import-labels", [...args, "--path", fixture.ambiguous_volume, "--handoff-id", stack.handoff_id]),
    /ZYX|scalar|samples|axes|RGB|one page per selected Z/i);
  assert.equal((await cli("results")).results.length, 1);
  const grant = await cli("import-labels", [...args, ...labels]);
  assert.equal(grant.handoff.handoff_id, stack.handoff_id);
  const request = { source_id: source.id, source_sha256: fixture.sha256, grant_id: grant.grant_id,
    alignment: "same-native-zyx-grid", producer: { name: "Authored QA labels", model: "synthetic-test-declaration" } };
  const job = await cli("submit", ["--operation", "labels_import", "--request", JSON.stringify(request), "--request-key", "volume-labels", "--run"]);
  assert.equal(job.job.state, "succeeded");
  await checkAdoption(job.result.id, volume, stack, "ZYX", fixture);
  await cli("review", ["--result", planeResult.id, "--revision", planeResult.revision_hash, "--disposition", "reviewed"]);
  const reviewed = path.join(output, "reviewed-plane");
  await cli("export", ["--result", planeResult.id, "--revision", planeResult.revision_hash, "--destination", reviewed]);
  const methods = await fs.readFile(path.join(reviewed, "methods.md"), "utf8");
  assert.ok(methods.includes(plane.handoff_id) && methods.includes("synthetic-test-declaration") && !methods.includes(output));
  assert.equal(await sha(fixture.source), fixture.sha256);
  receipt.checks.push("Bundled CLI verified nonzero T/C and a partial Z stack, raw pixels and sparse instance measurements",
    "Refused overwrite, shifted T and ambiguous RGB TIFF before import", "Exact-revision reviewed export retained handoff and declared producer");
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error);
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try { await close(); }
  finally {
    receipt.completed_at = new Date().toISOString();
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(output, receipt.status);
  }
}
