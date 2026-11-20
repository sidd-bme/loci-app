import assert from "node:assert/strict";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

/** Exercise the ordered editor on the loaded public kidney image. */
export async function auditPreprocessingInspector(page, sourceId, capture) {
  await selectWorkbenchTool(page, "Process");
  const scope = page.getByRole("region", { name: "Analysis scope", exact: true });
  const pipeline = page.getByRole("region", { name: "Processing pipeline", exact: true });
  const action = (root, name) => root.getByRole("button", { name, exact: true });
  const whole = action(scope, "Whole image");
  const region = action(scope, "Region");
  const add = action(pipeline, "Add processing step");
  const preview = action(page, "Preview selected crop");
  const memory = page.locator(".preprocess-inspector-memory details");
  const viewport = page.locator(`.image-viewport[data-viewer-source="${sourceId}"][data-prepared="true"]`).first();
  const list = pipeline.locator("ol");
  const before = await page.evaluate(() => window.lociResearch.getSnapshot());

  await whole.click();
  assert.equal(await whole.getAttribute("aria-pressed"), "true");
  assert.match(await scope.innerText(), /512 × 512 px/);
  assert.equal(await memory.evaluate(el => el.open), false);
  assert.equal(await list.getByRole("listitem").count(), 0);
  assert.ok(await memory.evaluate(node => {
    const primary = document.querySelector(".preprocess-preview-btn");
    return primary && (primary.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await capture("12-preprocessing-empty");

  await region.click();
  await action(scope, "Cancel drawing").click();
  assert.equal(await whole.getAttribute("aria-pressed"), "true");
  await region.click();
  const box = await viewport.locator("canvas").first().boundingBox();
  assert.ok(box && box.width > 200 && box.height > 200);
  await page.mouse.move(box.x + box.width * 0.43, box.y + box.height * 0.43);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.56, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await action(scope, "Redraw region").waitFor();
  assert.equal(await region.getAttribute("aria-pressed"), "true");
  const selectedScope = await scope.innerText();
  assert.match(selectedScope, /X\s*\d+,\s*Y\s*\d+/);

  await add.click();
  for (const [name, ops] of [
    ["Smoothing", ["Gaussian blur", "Median filter"]],
    ["Background & intensity", ["Background subtraction", "Subtract constant"]],
    ["Morphology", ["Morphological opening", "Morphological closing"]],
  ]) {
    const group = pipeline.getByRole("group", { name, exact: true });
    for (const op of ops) assert.ok(await action(group, op).isVisible());
  }
  await capture("13-preprocessing-operations");
  await action(pipeline, "Subtract constant").click();
  await pipeline.getByLabel("Step 1 value", { exact: true }).fill("50.5");
  await add.click();
  await action(pipeline, "Gaussian blur").click();
  const sigma = pipeline.getByLabel("Step 2 sigma", { exact: true });
  await sigma.fill("");
  assert.equal(await preview.isDisabled(), true);
  await sigma.fill("0.75");
  await action(pipeline, "Move step 2 up").click();
  assert.equal(await pipeline.getByLabel("Step 1 sigma", { exact: true }).inputValue(), "0.75");
  const rowNames = await list.locator(".preprocess-step-label").allTextContents();
  assert.deepEqual(rowNames, ["Gaussian blur", "Subtract constant"]);
  await capture("14-preprocessing-ordered");

  await preview.click();
  await viewport.locator(".image-view-readout").getByText(/^Preview · /u).waitFor({ timeout: 30000 });
  await capture("15-preprocessing-preview");
  const after = await page.evaluate(() => window.lociResearch.getSnapshot());
  const revisions = state => state.results.map(row => [row.id, row.revision_hash]);
  assert.deepEqual(revisions(after), revisions(before));
  assert.equal(after.sources.find(image => image.id === sourceId)?.sha256,
    before.sources.find(image => image.id === sourceId)?.sha256);
  return { source_id: sourceId, scope: selectedScope, steps: rowNames, sigma: 0.75,
    subtract_constant: 50.5, preview_rendered: true, saved_results_unchanged: true };
}
