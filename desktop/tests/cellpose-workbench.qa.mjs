import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

// A bounded real learned-model journey complements the full classical batch,
// correction and recovery suite. Its CPU reference is fixed before this run.
const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "../..");
function required(name) {
  assert.ok(
    process.env[name] && path.isAbsolute(process.env[name]),
    `${name} must be an explicit absolute path`,
  );
  return process.env[name];
}
const appBundle = required("LOCI_PACKAGED_APP");
const source = required("LOCI_QA_IMAGE");
const checkpoint = required("LOCI_QA_CELLPOSE_CHECKPOINT");
const cpuReference = required("LOCI_QA_CPU_REFERENCE");
const output = required("LOCI_QA_OUTPUT_ROOT");
assert.equal(
  process.platform,
  "darwin",
  "This journey targets the packaged macOS runtime",
);
const relativeOutput = path.relative(projectRoot, output);
assert.ok(
  relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`),
  "QA output must be outside the repository",
);
const executablePath = path.join(appBundle, "Contents/MacOS/Loci");
const workerPath = path.join(
  appBundle,
  "Contents/Resources/loci-engine/loci-engine",
);
const archivePath = path.join(appBundle, "Contents/Resources/app.asar");
const userData = path.join(output, "user-data");
const project = path.join(output, "cellpose-qualification.loci-study");
const exportDirectory = path.join(output, "export");
await fs.mkdir(output); // Fail rather than reuse evidence from another run.
await fs.mkdir(userData);

async function sha(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const sourceHash = await sha(source);
assert.equal(
  sourceHash,
  "2b086faa8e3b55202ea40604da32aec01aa7e99c7a7df861d03e773430730539",
);
assert.equal(
  await sha(checkpoint),
  "e1440429eb384f95afe32bcba6510f90d518eaedc917ede549bed6804004abe2",
);
assert.equal(
  await sha(cpuReference),
  "9f2d248fe1ded0b1d7963692dcf87c0ffcd6aa94799d45f9746d7a8324e5adf2",
);
const errors = [];
const requests = [];
const timings = {};
let app;
let page;
async function launch() {
  const start = performance.now();
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) requests.push(request.url());
  });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1024, 720); window.show(); window.focus(); },
  );
  timings.launch_seconds ??= (performance.now() - start) / 1000;
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        if (options.title === "Add microscopy or medical images")
          return { canceled: false, filePaths: [values.source] };
        if (options.title?.startsWith("Import verified"))
          return { canceled: false, filePaths: [values.checkpoint] };
        if (options.title === "Open research study")
          return { canceled: false, filePaths: [values.project] };
        throw new Error(`Unexpected qualification picker: ${options.title}`);
      };
      dialog.showSaveDialog = async (...args) => {
        const options = args.at(-1);
        if (options.title === "Save research study as")
          return { canceled: false, filePath: values.project };
        if (options.title === "Export reviewed result bundle")
          return { canceled: false, filePath: values.exportDirectory };
        throw new Error(
          `Unexpected qualification save picker: ${options.title}`,
        );
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    { source, checkpoint, exportDirectory, project },
  );
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = undefined;
}
async function waitFor(read, accept, description, timeout = 60_000) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeout) {
    last = await read();
    if (accept(last)) return last;
    const alert = await page.locator('.research-error[role="alert"]').textContent().catch(() => null);
    if (alert) throw new Error(`${description}: ${alert}`);
    await page.waitForTimeout(150);
  }
  throw new Error(`${description}: timed out; last value ${JSON.stringify(last)}`);
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const resultRecord = (result_id) => page.evaluate((id) => window.lociResearch.execute("result", { result_id: id }), result_id);
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: false });
}
try {
  await launch();
  // Every mutation is initiated through ordinary UI controls. Read-only bridge
  // snapshots establish exact scientific identities independently of UI labels.
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const opened = await waitFor(snapshot, (value) => value?.sources.length === 1, "direct image opening");
  assert.equal(opened.results.length, 0, "Opening a source unexpectedly ran analysis");
  assert.equal(opened.sources[0].sha256, sourceHash);
  assert.deepEqual(opened.sources[0].metadata.dimensions, { t: 1, c: 1, z: 1, y: 256, x: 256 });
  await page.waitForFunction(() => Number(document.querySelector('.image-viewport')?.getAttribute('data-cache-bytes')) > 0 && !document.querySelector('.image-view-loading'), null, { timeout: 60_000 });
  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("cellpose-sam");
  await page.getByRole("button", { name: "Import checkpoint…", exact: true }).click();
  await page.getByText("Ready locally", { exact: true }).waitFor({ timeout: 120_000 });
  const device = page.getByLabel("Compute device", { exact: true });
  if (!(await device.isVisible())) await page.locator('.cellpose-advanced > summary').click();
  await device.selectOption("cpu");
  await screenshot("01-provisioned-cpu.png");
  const started = performance.now();
  await page.getByRole("button", { name: "Segment image", exact: true }).click();
  const analyzed = await waitFor(snapshot, (value) => value?.results.length === 1, "pinned CPU inference", 420_000);
  timings.inference_seconds = (performance.now() - started) / 1000;
  const summary = analyzed.results[0];
  assert.equal(summary.kind, "cellpose-segmentation");
  assert.equal(summary.object_count, 46, "Pinned supplier image CPU regression count changed");
  assert.equal(summary.source_id, opened.sources[0].id);
  const computed = await resultRecord(summary.id);
  const runtime = computed.provenance.runtime.cellpose;
  assert.equal(runtime.package.version, "4.2.1.1");
  assert.equal(runtime.model.sha256, await sha(checkpoint));
  assert.equal(runtime.requested_device, "cpu");
  assert.equal(runtime.resolved_device, "cpu");
  assert.equal(runtime.fallback_reason, null);
  assert.equal(computed.provenance.profile.id, "cellpose-sam");
  assert.deepEqual(computed.result.arrays.labels.shape, [256, 256]);
  assert.equal(computed.result.source_sha256, sourceHash);
  await page.locator(`[data-result-id="${summary.id}"][aria-pressed="true"]`).waitFor();
  await page.locator('.image-viewport[data-result-overlay]').waitFor();
  await screenshot("02-learned-result.png");
  await selectWorkbenchTool(page, "Info");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await waitFor(snapshot, (value) => value.results[0]?.review?.disposition === "reviewed", "review exact result");
  await fileMenuAction(page, "Save as study…");
  await waitFor(() => fs.stat(project).catch(() => null), (value) => value?.isDirectory(), "save managed session as a study");
  const saved = await snapshot();
  assert.equal(saved.sources.length, 1);
  assert.equal(saved.results.length, 1);
  assert.equal(saved.results[0].review.disposition, "reviewed");
  const savedRecord = await resultRecord(summary.id);
  assert.deepEqual(savedRecord.result.arrays, computed.result.arrays);
  assert.deepEqual(savedRecord.provenance, computed.provenance);
  // The clone makes a new document. Explicitly select its retained result.
  await page.locator(`[data-result-id="${summary.id}"]`).click();
  await selectWorkbenchTool(page, "Info");
  await page.getByRole("button", { name: "Export revision", exact: true }).click();
  await waitFor(() => fs.stat(path.join(exportDirectory, "manifest.json")).catch(() => null),
    (value) => value?.isFile(), "atomic reviewed export");
  const exported = JSON.parse(await fs.readFile(path.join(exportDirectory, "result.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(exportDirectory, "manifest.json"), "utf8"));
  assert.equal(exported.review.disposition, "reviewed");
  assert.equal(exported.result.revision_hash, summary.revision_hash);
  const { measurements: _measurements, ...exportedProvenance } = exported.result.provenance;
  assert.equal(_measurements.length, 46);
  assert.deepEqual(exportedProvenance, savedRecord.provenance);
  assert.equal(exported.source.sha256, sourceHash);
  assert.equal("path" in exported.source, false);
  for (const artifact of manifest.files) {
    assert.equal(path.basename(artifact.name), artifact.name, "Export name escapes its bundle");
    assert.equal(await sha(path.join(exportDirectory, artifact.name)), artifact.sha256);
  }
  const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(projectRoot, "engine/.venv/bin/python");
  const verification = await run(python, [
    "-c",
    "import json,sys,numpy as np,tifffile; a=np.load(sys.argv[1],allow_pickle=False); b=np.load(sys.argv[2],allow_pickle=False); c=tifffile.imread(sys.argv[3]); assert a.dtype.kind=='u'; np.testing.assert_array_equal(a,b); np.testing.assert_array_equal(c,b); assert a.shape==(256,256); print(json.dumps({'shape':list(a.shape),'dtype':str(a.dtype),'all_voxels_equal':True,'ome_tiff_equal':True,'objects':int(np.unique(a[a>0]).size)}))",
    path.join(exportDirectory, "labels.npy"), cpuReference, path.join(exportDirectory, "labels.ome.tif"),
  ]);
  const numerical = JSON.parse(verification.stdout);
  assert.equal(numerical.objects, 46);
  await screenshot("03-reviewed-export.png");
  await close();
  await launch();
  // The saved study may be recovered automatically; if not, use its visible
  // recent record. Neither route is allowed to initiate new inference.
  if (await page.locator('main.image-first-empty').count()) {
    const recent = page.locator('.recent-sessions button', { hasText: "cellpose-qualification" });
    await recent.click();
  }
  const reopened = await waitFor(snapshot, (value) => value?.results.length === 1, "saved study reopening");
  assert.deepEqual(reopened.sources, saved.sources);
  assert.deepEqual(reopened.results, saved.results);
  const restored = await resultRecord(summary.id);
  assert.deepEqual(restored.result, savedRecord.result);
  assert.deepEqual(restored.provenance, savedRecord.provenance);
  assert.equal(restored.result.review.disposition, "reviewed");
  await page.locator(`[data-result-id="${summary.id}"]`).click();
  await page.locator('.image-viewport[data-result-overlay]').waitFor();
  await selectWorkbenchTool(page, "Info");
  await screenshot("04-reopened.png");
  await close();
  assert.equal(await sha(source), sourceHash);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const report = {
    schema: "loci.cellpose-packaged-qualification/v1",
    source_sha256: sourceHash,
    checkpoint_sha256: await sha(checkpoint),
    cpu_reference_sha256: await sha(cpuReference),
    application_sha256: await sha(executablePath),
    worker_sha256: await sha(workerPath),
    asar_sha256: await sha(archivePath),
    timings,
    numerical,
    runtime,
    result_id: summary.id,
    revision_hash: summary.revision_hash,
    result_arrays: savedRecord.result.arrays,
    exact_reopen: true,
    renderer_http_requests: requests,
    renderer_errors: errors,
    meaning:
      "Technical reproducibility against a predeclared CPU reference; no biological accuracy or model-rights claim.",
  };
  await fs.writeFile(
    path.join(output, "qa-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  if (page && !page.isClosed()) {
    await screenshot("failure.png").catch(() => undefined);
    await fs
      .writeFile(
        path.join(output, "failure-ui.txt"),
        await page.locator("body").innerText(),
      )
      .catch(() => undefined);
  }
  await fs.writeFile(
    path.join(output, "qa-failure.json"),
    JSON.stringify(
      { error: String(error), errors, requests, timings },
      null,
      2,
    ),
  );
  await close().catch(() => app?.close());
  throw error;
}
