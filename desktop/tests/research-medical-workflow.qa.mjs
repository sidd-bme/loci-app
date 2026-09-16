import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

// This is an independent decoder for the exact exported NIfTI-1 QA subset.
// It does not participate in application import, analysis, or publication.
async function checkNifti(file, labels) {
  const bytes = gunzipSync(await fs.readFile(file));
  assert.equal(bytes.readInt32LE(0), 348);
  assert.equal(bytes.subarray(344, 348).toString("binary"), "n+1\0");
  assert.deepEqual([1, 2, 3].map((axis) => bytes.readInt16LE(40 + 2 * axis)), [5, 6, 7]);
  assert.equal(bytes[123] & 7, 2, "Exported NIfTI must explicitly declare millimetres");
  assert.equal(bytes.readInt16LE(70), labels ? 768 : 64);
  assert.equal(bytes.readInt16LE(72), labels ? 32 : 64);
  const offset = bytes.readFloatLE(108);
  assert.ok(Number.isSafeInteger(offset) && offset >= 352);
  const angle = Math.PI / 6;
  const affine = [
    [Math.cos(angle) * 0.7, -Math.sin(angle) * 0.8, 0, 10],
    [Math.sin(angle) * 0.7, Math.cos(angle) * 0.8, 0, 20],
    [0, 0, 1.2, 30],
  ];
  assert.ok(bytes.readInt16LE(254) > 0);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++)
    assert.ok(Math.abs(bytes.readFloatLE(280 + row * 16 + column * 4) - affine[row][column]) < 1e-5,
      `NIfTI RAS affine mismatch at ${row},${column}`);
  for (let z = 0; z < 7; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 5; x++) {
    const index = z * 30 + y * 5 + x;
    const raw = x * 42 + y * 7 + z;
    const actual = labels ? bytes.readUInt32LE(offset + index * 4) : bytes.readDoubleLE(offset + index * 8);
    assert.equal(actual, labels ? Number(raw > 100) : raw);
  }
}

export async function qualifyMedicalWorkflow({ app, page, runRoot, screenshot, noUiError }) {
  const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
  const tools = new Set(["Display", "Correction", "Analyze", "Info"]);
  const click = async (name) => {
    if (tools.has(name)) return selectWorkbenchTool(page, name);
    return page.getByRole("button", { name, exact: true }).click();
  };
  const openAnalysisRegion = async () => {
    const details = page.locator("details.analysis-region-settings");
    if (!await details.evaluate((element) => element.open)) {
      await details.locator("summary").click();
    }
  };
  const wait = async (read, accepts, label) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await noUiError(page, label);
      const value = await read();
      if (accepts(value)) return value;
      await page.waitForTimeout(150);
    }
    throw new Error("Medical workflow did not complete: " + label);
  };
  await page.locator(".research-sources").getByRole("button", { name: /^oblique_scalar\.nii/ }).click();
  await click("Display");
  await openAnalysisRegion();
  for (const [label, value] of [["X", "0"], ["Y", "0"], ["Z", "0"], ["Width", "5"], ["Height", "6"]])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("Display scope").selectOption("max");
  await page.getByLabel("Z stop", { exact: true }).fill("7");
  await click("Load linked orthogonal crop");
  await page.getByAltText("XZ orthogonal plane").waitFor();
  await screenshot(page, "medical-oblique-orthogonal");
  await click("Analyze");
  await page.getByLabel("Threshold", { exact: true }).fill("100");
  const before = new Set((await snapshot()).results.map((item) => item.id));
  await click("Run recipe");
  const state = await wait(snapshot, (value) => value.results.some((item) => !before.has(item.id)), "3D segmentation");
  const result = state.results.find((item) => !before.has(item.id));
  const record = await page.evaluate((result_id) => window.lociResearch.execute("result", { result_id }), result.id);
  assert.equal(result.object_count, 1);
  assert.deepEqual(result.arrays.labels.shape, [7, 6, 5]);
  assert.equal(record.measurements[0].voxel_count, 109);
  assert.equal(record.measurements[0].measure_unit, "mm^3");
  assert.ok(Math.abs(record.measurements[0].measure - 73.248) < 1e-5);
  assert.equal(Object.values(record.measurements[0].intensity)[0].sum, 16895);
  assert.equal(record.provenance.geometry.frame, "LPS");
  assert.equal(record.provenance.geometry.axes, "ZYX");
  await wait(async () => page.locator(`[data-result-id="${result.id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"), "exact result display");
  await screenshot(page, "medical-calibrated-3d-result");

  await click("Correction");
  await page.getByLabel("Correction label", { exact: true }).selectOption("1");
  await click("Delete selected label");
  const correctedState = await wait(snapshot, (value) => value.results.some((item) => item.parent_id === result.id), "3D label correction");
  const corrected = correctedState.results.find((item) => item.parent_id === result.id);
  assert.equal(corrected.object_count, 0);
  await click("Undo revision");
  await wait(async () => page.locator(`[data-result-id="${result.id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"), "exact medical correction undo");
  const destination = path.join(runRoot, "medical-volume-export");
  await app.evaluate(({ dialog }, output) => {
    const previous = dialog.showSaveDialog;
    dialog.showSaveDialog = async (...args) => {
      if (args.at(-1)?.title === "Export reviewed result bundle") {
        dialog.showSaveDialog = previous;
        return { canceled: false, filePath: output };
      }
      return previous(...args);
    };
  }, destination);
  await click("Info");
  await click("Mark reviewed");
  await wait(snapshot, (value) => value.results.some((item) => item.id === result.id && item.review?.disposition === "reviewed"), "review exact medical revision");
  await click("Export revision");
  await wait(() => fs.stat(path.join(destination, "manifest.json")).catch(() => null), (value) => value?.size > 0, "atomic medical export");
  await checkNifti(path.join(destination, "image.nii.gz"), false);
  await checkNifti(path.join(destination, "labels.nii.gz"), true);
  return { resultId: result.id, correctedId: corrected.id, voxelCount: 109, volumeMm3: record.measurements[0].measure,
    intensitySum: 16895, independentExportPixelsAndRasAffine: true, exactCorrectionUndo: true };
}
