/**
 * Packaged segmentation working-memory allowance, adaptive execution, failure/recovery,
 * Cellpose readiness/profile checks, label correction, and result review/export journey.
 *
 * NOTE: Preparing this harness does not constitute qualification. Actual packaged execution
 * awaits a qualification build produced by the integration lead (Astra).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import { selectResultSection, fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
assert.ok(bundle, "Set LOCI_PACKAGED_APP to the exact qualification candidate");

const root = path.join(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repo, ".loci/evidence/segmentation-resources"),
  new Date().toISOString().replaceAll(":", "-"),
);
await fs.mkdir(root, { recursive: true });

const fixture = path.join(root, "synthetic-3088x2076.ome.tif");
const generator = path.join(root, "generate-fixture.py");

// Generate synthetic 3088x2076 grayscale image with 2 known 100x100 square objects and explicit geometry.
// Dimensions: 2076 rows (Y) x 3088 columns (X) = 6,410,688 pixels.
// Arithmetic:
// - Source load budget check: voxels * 96 = 6,410,688 * 96 = 615,426,048 bytes (~586.9 MiB).
//   This deterministically exceeds the default 512 MiB (536,870,912 bytes) allowance.
// - Aggregate required bytes in adaptive segmentation:
//   int(image.nbytes) + pixels * (160 + 8 * len(measurement_channels))
//   = 6,410,688 + 6,410,688 * (160 + 8 * 1) = 1,083,406,272 bytes (~1.01 GiB).
//   This requires an explicit allowance of at least 2 GiB (2,147,483,648 bytes).
await fs.writeFile(
  generator,
  `from pathlib import Path
import numpy as np
import tifffile

h, w = 2076, 3088
a = np.full((h, w), 225, dtype=np.uint8)

# Object 1: 100x100 square (10,000 pixels) with raw intensity 55
a[100:200, 100:200] = 55

# Object 2: 100x100 square (10,000 pixels) with raw intensity 55
a[500:600, 500:600] = 55

tifffile.imwrite(
    Path(__file__).parent / 'synthetic-3088x2076.ome.tif',
    a,
    tile=(256, 256),
    ome=True,
    photometric='minisblack',
    metadata={
        'axes': 'YX',
        'PhysicalSizeX': 0.5,
        'PhysicalSizeXUnit': 'µm',
        'PhysicalSizeY': 0.5,
        'PhysicalSizeYUnit': 'µm',
    },
)
print("Synthetic 3088x2076 grayscale fixture generated.")
`,
);

execFileSync(path.join(repo, "engine/.venv/bin/python"), [generator]);

const study = path.join(root, "segmentation-resource-study.loci-study");
const exported = path.join(root, "reviewed-adaptive-result");
const sha = async (p) =>
  createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");

const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  kind: "packaged synthetic segmentation allowance / adaptive execution / failure recovery / correction / save-reopen",
  fixture_sha256: await sha(fixture),
  identity: {
    executable: await sha(path.join(bundle, "Contents/MacOS/Loci")),
    asar: await sha(path.join(bundle, "Contents/Resources/app.asar")),
    worker: await sha(path.join(bundle, "Contents/Resources/loci-engine/loci-engine")),
    harness: await sha(import.meta.filename),
  },
  cellpose_inference: "NOT EXERCISED (no approved local checkpoint in qualification candidate)",
  screenshots: [],
  errors: [],
};

const app = await electron.launch({
  executablePath: path.join(bundle, "Contents/MacOS/Loci"),
  args: [`--user-data-dir=${path.join(root, "user-data")}`],
  cwd: path.join(repo, "desktop"),
  timeout: 60000,
});

const page = await app.firstWindow();
page.on("pageerror", (e) => report.errors.push(e.message));

async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(80);
  }
  throw new Error("Timed out: " + label);
}

async function capture(name) {
  const p = path.join(root, name + ".png");
  await page.screenshot({ path: p });
  report.screenshots.push({ path: p, sha256: await sha(p) });
}

try {
  await app.evaluate(
    ({ dialog, BrowserWindow }, { fixture, study, exported }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 40, width: 1280, height: 900 });
      dialog.showOpenDialog = async (...args) => ({
        canceled: false,
        filePaths: [args.at(-1)?.title === "Open research study" ? study : fixture],
      });
      dialog.showSaveDialog = async (...args) => ({
        canceled: false,
        filePath: args.at(-1)?.title === "Export reviewed result bundle" ? exported : study,
      });
    },
    { fixture, study, exported },
  );

  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  // 1. Inspect Cellpose segmentation controls across both profiles and test allowance retention
  const modelSelect = page.getByLabel("Segmentation model");
  await modelSelect.selectOption("cellpose-sam");

  const cellposeAllowance = page.getByLabel("Cellpose memory allowance");
  await cellposeAllowance.waitFor({ timeout: 10000 });
  assert.ok(await cellposeAllowance.isVisible());

  // Select 2 GiB in Cellpose-SAM
  await cellposeAllowance.selectOption(String(2 * 1024 ** 3));
  assert.equal(await cellposeAllowance.inputValue(), String(2 * 1024 ** 3));
  await capture("01-cellpose-sam-2gib");

  // Switch to Cellpose-SAM v2: verify allowance is retained
  await modelSelect.selectOption("cellpose-sam-v2");
  const cellposeV2Allowance = page.getByLabel("Cellpose memory allowance");
  await cellposeV2Allowance.waitFor({ timeout: 10000 });
  assert.equal(await cellposeV2Allowance.inputValue(), String(2 * 1024 ** 3));
  await capture("02-cellpose-sam-v2-retained-2gib");

  // Checkpoint status: unprovisioned checkpoint fails closed
  const checkpointNotice = page.locator(".model-availability, .model-ready");
  await checkpointNotice.waitFor({ timeout: 10000 });
  const isReady = await page.locator(".model-ready").count();
  if (!isReady) {
    report.cellpose_status = "Unprovisioned (verified local checkpoint required)";
    assert.equal(await page.getByRole("button", { name: "Segment image", exact: true }).isEnabled(), false);
  } else {
    report.cellpose_status = "Ready";
  }

  // 2. Switch to Loci Adaptive Watershed: verify 2 GiB allowance retained across method switch
  await modelSelect.selectOption("adaptive");
  const adaptiveAllowance = page.getByLabel("Adaptive memory allowance");
  await adaptiveAllowance.waitFor({ timeout: 10000 });
  assert.ok(await adaptiveAllowance.isVisible());
  assert.equal(await adaptiveAllowance.inputValue(), String(2 * 1024 ** 3));

  // Explicit settings: radius-one cross opening clips precisely four square corners.
  await page.getByLabel("Edge smoothing", {exact:true}).fill("0");
  await page.getByLabel("Expected diameter", {exact:true}).fill("22");
  await page.getByLabel(/^Imaging preset/).selectOption("brightfield");
  await page.getByLabel("Split touching cells", {exact:true}).uncheck();

  // Switch allowance to 512 MiB to verify budget refusal
  await adaptiveAllowance.selectOption(String(512 * 1024 ** 2));
  assert.equal(await adaptiveAllowance.inputValue(), String(512 * 1024 ** 2));
  await capture("03-adaptive-512mib");

  // Run with 512 MiB: must fail closed because 3088x2076 requires 615,426,048 bytes for source load
  await page.getByRole("button", { name: "Segment image", exact: true }).click();
  await page.locator(".research-alert").filter({ hasText: /working-memory budget/ }).waitFor({ timeout: 15000 });
  assert.equal((await page.evaluate(() => window.lociResearch.getSnapshot())).results.length, 0);
  await capture("04-budget-refusal");

  // 3. Recover by selecting 2 GiB explicit allowance
  await adaptiveAllowance.selectOption(String(2 * 1024 ** 3));
  assert.equal(await adaptiveAllowance.inputValue(), String(2 * 1024 ** 3));

  // Run with 2 GiB: must succeed
  await page.getByRole("button", { name: "Segment image", exact: true }).click();

  await until(
    async () => ((await page.evaluate(() => window.lociResearch.getSnapshot()))?.results.length ?? 0) === 1,
    "published adaptive result",
  );
  await until(() => page.getByRole("button", { name: "Segment image", exact: true }).isEnabled(), "run returned");

  assert.equal(await page.locator(".research-alert").count(), 0);

  // Verify published result provenance records exact 2 GiB allowance
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const parentId = snapshot.results[0].id;
  const parentResult = await page.evaluate(
    async (id) => window.lociResearch.execute("result", { result_id: id }),
    parentId,
  );

  assert.equal(parentResult.provenance.accepted_request?.working_bytes, 2 * 1024 ** 3);
  assert.equal(parentResult.provenance.resource_guard?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(parentResult.result.working_bytes, 2 * 1024 ** 3);

  // Verify measurement rows: 2 objects, each 9,996 voxels, 2499 µm² physical area, mean raw intensity 55.0
  const initialMeasurements = parentResult.measurements.sort((a, b) => a.label - b.label);
  assert.equal(initialMeasurements.length, 2);
  for (const row of initialMeasurements) {
    assert.equal(row.voxel_count, 9996);
    assert.equal(row.measure, 2499);
    assert.equal(row.intensity?.source_channel_0?.mean, 55.0);
  }

  // 4. Label correction: delete label 1 without explicit budget, resolving parent 2 GiB budget

  await selectWorkbenchTool(page, "Correction");

  // Wait for correction panel to load and bind exact revision
  await page.getByRole("button", { name: "Delete selected label", exact: true }).waitFor({ timeout: 10000 });
  await capture("05-correction-panel-bound");

  // Delete label 1: creates unreviewed child revision
  await page.getByLabel("Correction label", {exact:true}).selectOption("1");
  await page.getByRole("button", { name: "Delete selected label", exact: true }).click();
  await until(
    async () => ((await page.evaluate(() => window.lociResearch.getSnapshot()))?.results.length ?? 0) === 2,
    "published corrected child revision",
  );

  const updatedSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const childId = updatedSnapshot.results.find((result) => result.parent_id === parentId).id;
  const childResult = await page.evaluate(
    async (id) => window.lociResearch.execute("result", { result_id: id }),
    childId,
  );

  assert.equal(childResult.result.parent_id, parentId);
  assert.equal(childResult.provenance.accepted_request?.working_bytes, 2 * 1024 ** 3);
  assert.equal(childResult.provenance.resource_guard?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(childResult.provenance.correction?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(childResult.result.working_bytes, 2 * 1024 ** 3);

  // Corrected child has exactly 1 remaining object (label 2)
  assert.equal(childResult.measurements.length, 1);
  assert.equal(childResult.measurements[0].label, 2);
  assert.equal(childResult.measurements[0].voxel_count, 9996);
  assert.equal(childResult.measurements[0].measure, 2499);
  assert.equal(childResult.measurements[0].intensity?.source_channel_0?.mean, 55.0);

  // Test Undo and Redo
  await page.getByRole("button", { name: "Undo revision", exact: true }).click();
  await until(async () => (await page.evaluate(() => window.lociResearch.getSnapshot())).selections.some((item) => item.data.result_id === parentId), "undo selected parent");
  await page.getByRole("button", { name: "Redo revision", exact: true }).click();
  await until(async () => (await page.evaluate(() => window.lociResearch.getSnapshot())).selections.some((item) => item.data.result_id === childId), "redo selected child");

  // 5. Review and Export
  await selectWorkbenchTool(page, "Info");
  await selectResultSection(page, "Review"); await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await selectResultSection(page, "Export"); await page.getByRole("button", { name: "Export result", exact: true }).click();

  await until(() => fs.stat(path.join(exported, "manifest.json")).then(() => true, () => false), "atomic reviewed export");

  const exportRecord = JSON.parse(await fs.readFile(path.join(exported, "result.json"), "utf8"));
  assert.equal(exportRecord.result.provenance.accepted_request?.working_bytes, 2 * 1024 ** 3);
  assert.equal(exportRecord.result.provenance.resource_guard?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(exportRecord.source.sha256, report.fixture_sha256);

  const manifest = JSON.parse(await fs.readFile(path.join(exported, "manifest.json"), "utf8"));
  for (const file of manifest.files) {
    assert.equal(await sha(path.join(exported, file.name)), file.sha256);
  }

  // Export oracle: verify normalized image array and corrected label array
  const oracle = path.join(root, "export-oracle.py");
  await fs.writeFile(
    oracle,
    `from pathlib import Path
import numpy as np
import tifffile

root = Path(__file__).parent
source = tifffile.imread(root / 'synthetic-3088x2076.ome.tif')
image = tifffile.imread(root / 'reviewed-adaptive-result/image.ome.tif')
labels = tifffile.imread(root / 'reviewed-adaptive-result/labels.ome.tif')

# Adaptive image is a normalized float32 scalar YX grid rescaled from [55.0, 225.0] to [0.0, 1.0].
assert image.shape == (2076, 3088)
assert image.dtype == np.float32
expected_image = ((source.astype(np.float32) - 55) / 170)
np.testing.assert_array_equal(image, expected_image)
expected_labels = np.zeros((2076,3088), dtype=np.uint32)
expected_labels[500:600,500:600] = 2
for y,x in [(500,500),(500,599),(599,500),(599,599)]:
    expected_labels[y,x] = 0
np.testing.assert_array_equal(labels, expected_labels)

print("Export oracle passed: exact normalized scalar array and corrected labels verified.")
`,
  );

  report.export_oracle = execFileSync(
    path.join(repo, "engine/.venv/bin/python"),
    [oracle],
    { encoding: "utf8" },
  ).trim();
  report.export_manifest_sha256 = await sha(path.join(exported, "manifest.json"));

  // 6. Save and reopen study
  await page.getByRole("button", { name: "Save study", exact: true }).click();
  await until(() => fs.stat(path.join(study, "study.sqlite3")).then(() => true, () => false), "saved study");
  await until(
    async () => (await page.locator("main.image-first-workbench").getAttribute("aria-busy")) !== "true",
    "save document lock released",
  );

  await fileMenuAction(page, "Open study");
  await until(
    async () => (await page.locator("main.image-first-workbench").getAttribute("aria-busy")) !== "true",
    "open document lock released",
  );

  const restored = await page.evaluate(
    async (id) => window.lociResearch.execute("result", { result_id: id }),
    childId,
  );
  assert.equal(restored.provenance.accepted_request?.working_bytes, 2 * 1024 ** 3);
  assert.equal(restored.provenance.resource_guard?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(restored.provenance.correction?.working_memory_limit_bytes, 2 * 1024 ** 3);
  assert.equal(await sha(fixture), report.fixture_sha256);

  assert.equal(restored.result.revision_hash, childResult.result.revision_hash);
  const unchangedParent = await page.evaluate(id => window.lociResearch.execute("result", {result_id:id}), parentId);
  assert.equal(unchangedParent.result.revision_hash, parentResult.result.revision_hash);
  await page.getByRole("button", {name:/^corrected-labels/}).click();
  await selectWorkbenchTool(page, "Info");
  await page.locator("details.research-preview-rows > summary").click();
  await until(() => page.getByRole("region", {name:"Result measurements", exact:true}).locator("tbody tr").count().then(n => n === 1), "restored child visible measurements");
  assert.equal(await page.locator(".research-alert").count(), 0);
  await capture("06-restored-study");
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setBounds({width:1024,height:720}));
  await page.locator(".image-view-loading").waitFor({state:"hidden"});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture("07-compact-window");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  // Optional real inference uses only an explicitly supplied existing local checkpoint.
  if (process.env.LOCI_QA_CELLPOSE_CHECKPOINT) {
    await page.getByRole("button", {name:"Original image", exact:true}).click();
    await selectWorkbenchTool(page, "Analyze");
    await page.getByLabel("Segmentation model").selectOption("cellpose-sam");
    await app.evaluate(({dialog}, checkpoint) => {
      dialog.showOpenDialog = async () => ({canceled:false, filePaths:[checkpoint]});
    }, process.env.LOCI_QA_CELLPOSE_CHECKPOINT);
    await page.getByRole("button", {name:"Import checkpoint…", exact:true}).click();
    await page.locator(".model-ready").waitFor({timeout:120000});
    await page.getByLabel("Cellpose memory allowance").selectOption(String(2 * 1024 ** 3));
    if (process.env.LOCI_QA_CELLPOSE_MAX_EDGE) {
      await page.getByText("Advanced settings", {exact:true}).click();
      await page.getByLabel("Maximum inference edge", {exact:true}).fill(process.env.LOCI_QA_CELLPOSE_MAX_EDGE);
      report.cellpose_requested_max_edge = Number(process.env.LOCI_QA_CELLPOSE_MAX_EDGE);
    }
    const before = (await page.evaluate(() => window.lociResearch.getSnapshot())).results.map(r => r.id);
    await page.getByRole("button", {name:"Segment image", exact:true}).click();
    const neural = await until(async () => (await page.evaluate(() => window.lociResearch.getSnapshot())).results.find(r => !before.includes(r.id)), "real Cellpose publication", 180000);
    await until(() => page.getByRole("button", {name:"Segment image", exact:true}).isEnabled(), "Cellpose UI completed");
    assert.equal(await page.locator(".research-alert").count(), 0);
    const record = await page.evaluate(id => window.lociResearch.execute("result", {result_id:id}), neural.id);
    assert.equal(record.provenance.accepted_request.working_bytes, 2 * 1024 ** 3);
    assert.equal(record.provenance.accepted_request.profile_id, "cellpose-sam");
    assert.equal(record.result.source_sha256, report.fixture_sha256);
    report.cellpose_inference = {status:"passed", profile:"cellpose-sam", runtime:record.provenance.runtime.cellpose,
      result_id: record.result.id, revision_hash: record.result.revision_hash, source_id: record.result.source_id,
      study, source: fixture, count:record.result.object_count, biological_validation:false};
    await page.getByRole("button", { name: "Save study", exact: true }).click();
    await until(async () => (await page.locator("main.image-first-workbench").getAttribute("aria-busy")) !== "true",
      "save model result lock released");
    await capture("08-real-cellpose");
    assert.equal(await sha(fixture), report.fixture_sha256);
  }

  report.passed = [
    "Cellpose memory allowance control accessible across profiles",
    "Cellpose profile readiness inspected; inference coverage recorded separately",
    "Method switching retains chosen 2 GiB memory allowance across profiles and adaptive",
    "Adaptive 3088x2076 synthetic fixture exceeds default 512 MiB allowance",
    "Adaptive run under 512 MiB refuses with actionable budget error and publishes no result",
    "Adaptive 2 GiB explicit allowance executes successfully and publishes result with 2 verified objects",
    "Label correction deletes label 1 without explicit budget by resolving parent allowance",
    "Child revision records correction execution budget while preserving inference provenance",
    "Undo and redo navigate revision history cleanly",
    "Reviewed export includes manifest, exact normalized float32 array, and single-object label mask",
    "Save and reopen preserves recorded budget, revision hash, and source immutability",
  ];
  assert.equal(report.errors.length, 0);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = e.stack || String(e);
  await capture("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await app.close();
}

console.log(JSON.stringify({ root, status: report.status, failure: report.failure }));
