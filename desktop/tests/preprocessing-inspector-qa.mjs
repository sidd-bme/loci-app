import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const reference = fileURLToPath(new URL("./fixtures/preprocessing-preview.py", import.meta.url));
const exec = promisify(execFile);

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

/** Read the scope shown to the researcher before asking the engine what ran. */
async function readCrop(scope) {
  const text = await scope.innerText();
  const match = /(\d+)\s*×\s*(\d+)\s*px\s*·\s*1 plane\s*·\s*X (\d+),\s*Y (\d+)/u.exec(text);
  assert.ok(match, `Expected a bounded single-plane Analysis scope: ${text}`);
  const [width, height, x, y] = match.slice(1).map(Number);
  assert.match(text, /Z 9\/16/u);
  // A one-pixel drag-rounding difference across viewport scales is immaterial.
  for (const [actual, intended] of [[x, 220], [y, 220], [width, 67], [height, 62]]) {
    assert.ok(Math.abs(actual - intended) <= 2, `Unexpected crop: ${text}`);
  }
  return { x, y, width, height, z: 8, t: 0, c: 0, level: 0 };
}

/** Compare visible backing pixels to the separately decoded, oracle-verified crop. */
async function waitForCropPaint(canvas, selection, image, matches = true) {
  const sample = await canvas.evaluate(async (surface, { selection, image, matches }) => {
    const reference = new Image();
    reference.src = image;
    await reference.decode();
    const scratch = document.createElement("canvas");
    const expected = scratch.getContext("2d", { alpha: false });
    const painted = surface.getContext("2d");
    const viewport = surface.closest(".image-viewport");
    const deadline = performance.now() + 20_000;
    let projection, sample, referencePixels, differences;
    while (performance.now() < deadline) {
      const bounds = surface.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const camera = JSON.parse(viewport.dataset.camera);
      if (surface.isConnected && bounds.width > 0 && bounds.height > 0 &&
          surface.width === Math.round(bounds.width * ratio) && surface.height === Math.round(bounds.height * ratio)) {
        const geometry = JSON.stringify([bounds.width, bounds.height, ratio, camera]);
        if (projection !== geometry) {
          projection = geometry;
          // The pinned fixture has equal XY spacing. Read the interior to exclude the ROI outline.
          const { x, y, width, height } = selection;
          const left = bounds.width / 2 + (x - camera.x) * camera.scale;
          const top = bounds.height / 2 + (y - camera.y) * camera.scale;
          const drawWidth = width * camera.scale, drawHeight = height * camera.scale;
          const x0 = Math.ceil((left + 8) * ratio), y0 = Math.ceil((top + 8) * ratio);
          const x1 = Math.floor((left + drawWidth - 8) * ratio), y1 = Math.floor((top + drawHeight - 8) * ratio);
          if (x0 < 0 || y0 < 0 || x1 > surface.width || y1 > surface.height || x1 - x0 < 8 || y1 - y0 < 8) {
            throw new Error("The kidney crop interior is not visible at the current camera scale.");
          }
          sample = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, device_pixel_ratio: ratio, scale: camera.scale };
          scratch.width = surface.width;
          scratch.height = surface.height;
          expected.setTransform(ratio, 0, 0, ratio, 0, 0);
          expected.imageSmoothingEnabled = camera.scale * ratio < 1;
          expected.drawImage(reference, left, top, drawWidth, drawHeight);
          referencePixels = expected.getImageData(sample.x, sample.y, sample.width, sample.height).data;
        }
        const pixels = painted.getImageData(sample.x, sample.y, sample.width, sample.height).data;
        differences = 0;
        for (let i = 0; i < pixels.length; i++) {
          if (pixels[i] !== referencePixels[i]) differences++;
        }
        if ((differences === 0) === matches) return { ...sample, differences, pixels: Array.from(pixels) };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for kidney crop canvas ${matches ? "to match" : "to clear"} (${differences ?? "unknown"} differing bytes).`);
  }, { selection, image, matches });
  const { pixels, ...geometry } = sample;
  return { ...geometry, rgba_sha256: createHash("sha256").update(Buffer.from(pixels)).digest("hex") };
}

/** Exercise the real child editor and recover the preview produced by each UI click. */
export async function auditDetachedPreprocessing({ app, page, entry, capture, evidence, output, source, python, save, onPageError }) {
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  const preview = root => button(root, "Preview selected crop");
  const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
  const scope = root => root.getByRole("region", { name: "Analysis scope", exact: true });
  const pipeline = root => root.getByRole("region", { name: "Processing pipeline", exact: true });
  const viewer = page.locator(`.image-viewport[data-viewer-source="${entry.id}"][data-prepared="true"]`);
  const previewReadout = viewer.locator(".image-view-readout").getByText(/^Preview · /u);
  const before = await snapshot();
  const knownJobs = new Set(before.jobs.map(job => job.id));

  await selectWorkbenchTool(page, "Process");
  const [child] = await Promise.all([
    app.waitForEvent("window"),
    button(page, "Detach Preprocess").click(),
  ]);
  child.on("pageerror", onPageError);
  await pipeline(child).waitFor();
  await child.getByText(entry.name, { exact: true }).waitFor();
  assert.deepEqual(app.windows().filter(window => !window.isClosed()), [page, child]);
  const native = await app.browserWindow(child);
  evidence.document_title = await child.title();
  assert.equal(evidence.document_title, "Loci · Preprocess");
  try {
    evidence.window_title = await native.evaluate(win => win.getTitle());
    assert.equal(evidence.window_title, "Loci · Preprocess");
  } finally {
    await native.dispose();
  }
  await pipeline(page).waitFor({ state: "hidden" });
  await button(page, "Fit image").click();
  await button(scope(child), "Region").click();
  await button(scope(child), "Cancel drawing").waitFor();
  await page.getByText("Drag a rectangle on the image · Esc to cancel", { exact: true }).waitFor();
  const canvas = viewer.locator(":scope > canvas");
  const { x: centerX, y: centerY, scale } = JSON.parse(await viewer.getAttribute("data-camera"));
  const box = await canvas.boundingBox();
  assert.ok(box && scale > 0, "Fit the bound kidney plane before drawing");
  // The pinned kidney image has equal physical X and Y spacing.
  const screen = (x, y) => [box.x + box.width / 2 + (x - centerX) * scale,
    box.y + box.height / 2 + (y - centerY) * scale];
  await page.mouse.move(...screen(220, 220));
  await page.mouse.down();
  await page.mouse.move(...screen(287, 282), { steps: 8 });
  await page.mouse.up();
  await button(scope(child), "Redraw region").waitFor();
  const selection = await readCrop(scope(child));
  evidence.selection = selection;
  evidence.preview_result_path = "preview_recipe job → task_preview_get → preview.output.image";

  const addSubtract = async () => {
    await button(pipeline(child), "Add processing step").click();
    await button(pipeline(child), "Subtract constant").click();
  };
  const clip = root => pipeline(root).getByRole("checkbox", { name: "Clip negative values to zero", exact: true });
  const value = (root, row) => pipeline(root).getByLabel(`Step ${row} value`, { exact: true });
  await addSubtract();
  await value(child, 1).fill("550");
  await pipeline(child).getByText("source intensity", { exact: true }).waitFor();
  assert.equal(await clip(child).isChecked(), false);
  await clip(child).click();
  // The owner applies the edit before the native inspector displays its acknowledgement.
  await clip(child).and(child.locator(":checked")).waitFor();
  await addSubtract();
  await pipeline(child).getByText("step 1 intensity", { exact: true }).waitFor();
  await value(child, 2).fill("");
  await value(child, 2).and(child.locator('[aria-invalid="true"]')).waitFor();
  await preview(child).and(child.locator(":disabled")).waitFor();
  assert.deepEqual((await snapshot()).jobs.map(job => job.id), [...knownJobs], "Invalid edit must leave the job set untouched");
  evidence.invalid_draft_disabled_preview = true;

  await value(child, 2).fill("400");
  await value(child, 2).press("Enter");
  assert.equal(await clip(child).isChecked(), false);
  const clipped = { op: "subtract_constant", value: 550, clip_negative: true };
  const unclipped = { op: "subtract_constant", value: 400, clip_negative: false };
  const readSteps = rows => rows.map(step => ({
    op: step.op, value: step.value, clip_negative: step.clip_negative ?? false,
  }));
  const runPreview = async (root, label, steps) => {
    await previewReadout.waitFor({ state: "hidden" });
    await preview(root).click();
    const after = await waitForSnapshot(page,
      state => state.jobs.some(job => job.operation === "preview_recipe" && !knownJobs.has(job.id) &&
        !["queued", "running"].includes(job.state)), `${label} preview job`);
    const jobs = after.jobs.filter(job => !knownJobs.has(job.id));
    assert.equal(jobs.length, 1, "Each Preview click creates exactly one task");
    const [job] = jobs;
    assert.equal(job.state, "succeeded", job.error ?? undefined);
    assert.deepEqual(job.result_ids, []);
    knownJobs.add(job.id);
    await preview(root).and(root.locator(":enabled")).waitFor();
    await previewReadout.waitFor({ timeout: 30_000 });
    const { preview: record } = await page.evaluate(job_id =>
      window.lociResearch.execute("task_preview_get", { job_id }), job.id);
    assert.equal(record.job_id, job.id);
    assert.equal(record.operation, "preview_recipe");
    assert.match(record.request_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(record.request_sha256, job.request_hash);
    assert.equal(record.source_id, entry.id);
    assert.equal(record.source_sha256, entry.sha256);
    assert.equal(record.adopted, false);
    const { provenance, image, display, adopted } = record.output;
    assert.equal(adopted, false);
    assert.equal(provenance.job_id, job.id);
    assert.equal(job.request.source_id, entry.id);
    assert.deepEqual(job.request.selection, selection);
    assert.deepEqual(provenance.selection, selection);
    assert.deepEqual(readSteps(job.request.recipe.steps), steps);
    assert.deepEqual(readSteps(provenance.processing), steps);
    assert.deepEqual(provenance.recipe, job.request.recipe);
    assert.equal(display.auto_algorithm, "selected-plane-min-max");
    assert.deepEqual([display.gamma, display.color, display.visible], [1, "#ffffff", true]);
    assert.ok(image.startsWith("data:image/png;base64,"));
    const png = Buffer.from(image.slice("data:image/png;base64,".length), "base64");
    const filename = `${label}-engine-preview.png`;
    const pngPath = path.join(output, filename);
    await writeFile(pngPath, png);
    const { stdout } = await exec(python, [reference, source, pngPath, JSON.stringify({
      selection, geometry: provenance.geometry, order: steps.map(step => step.value),
      bounds: [display.low, display.high],
    })]);
    const paintedCrop = await waitForCropPaint(canvas, selection, image);
    const result = {
      label, job_id: job.id, request_sha256: record.request_sha256, output_sha256: record.output_sha256,
      source_id: record.source_id, source_sha256: record.source_sha256, selection,
      recipe: provenance.recipe, recipe_sha256: provenance.recipe_sha256, geometry: provenance.geometry,
      filename, png_sha256: createHash("sha256").update(png).digest("hex"), oracle: JSON.parse(stdout),
      painted_crop: paintedCrop,
    };
    evidence.previews.push(result);
    await save();
    return { result, image };
  };

  const { result: first, image: firstImage } = await runPreview(child, "01-clipped-first", [clipped, unclipped]);
  await button(pipeline(child), "Move step 2 up").click();
  await value(child, 1).waitFor();
  assert.equal(await value(child, 1).inputValue(), "400");
  assert.equal(await clip(child).isChecked(), false);
  await previewReadout.waitFor({ state: "hidden" });
  evidence.cleared_after_reorder = await waitForCropPaint(canvas, selection, firstImage, false);
  const { result: reordered, image: reorderedImage } = await runPreview(child, "02-clipped-last", [unclipped, clipped]);
  assert.notEqual(reordered.oracle.actual_rgb_sha256, first.oracle.actual_rgb_sha256);
  assert.notEqual(reordered.request_sha256, first.request_sha256);
  await capture("03-detached-preprocess-reordered", { nativeWindow: true, target: child });
  await capture("04-main-crop-preview", { nativeWindow: true });

  await Promise.all([child.waitForEvent("close"), button(child, "Dock Preprocess").click()]);
  await pipeline(page).waitFor();
  await button(page, "Detach Preprocess").and(page.locator(":focus")).waitFor({ timeout: 5000 });
  evidence.focus_after_dock = "Detach Preprocess";
  assert.deepEqual(await readCrop(scope(page)), selection);
  await previewReadout.waitFor();
  evidence.paint_after_dock = await waitForCropPaint(canvas, selection, reorderedImage);
  const toggles = pipeline(page).locator(".preprocess-step-toggle");
  for (const [index, step] of [unclipped, clipped].entries()) {
    const row = toggles.nth(index);
    if (await row.getAttribute("aria-expanded") !== "true") await row.click();
    assert.equal(await value(page, index + 1).inputValue(), String(step.value));
    assert.equal(await clip(page).isChecked(), step.clip_negative);
  }
  const layers = button(page, "Layers & results");
  if (await layers.getAttribute("aria-expanded") !== "true") await layers.click();
  await button(page, "Original image").click();
  await previewReadout.waitFor({ state: "hidden" });
  evidence.cleared_before_docked_preview = await waitForCropPaint(canvas, selection, reorderedImage, false);
  const { result: docked } = await runPreview(page, "05-docked", [unclipped, clipped]);
  for (const key of ["source_id", "source_sha256", "selection", "geometry", "recipe", "recipe_sha256", "request_sha256", "png_sha256"]) {
    assert.deepEqual(docked[key], reordered[key], `Docking changed ${key}`);
  }
  await capture("06-docked-preprocess", { nativeWindow: true });
  const after = await snapshot();
  assert.deepEqual(after.sources.map(item => [item.id, item.sha256]), before.sources.map(item => [item.id, item.sha256]));
  assert.deepEqual(after.results.map(result => [result.id, result.revision_hash]),
    before.results.map(result => [result.id, result.revision_hash]));
  evidence.saved_results_unchanged = true;
  evidence.source_recipe_geometry_preserved_on_dock = true;
}
