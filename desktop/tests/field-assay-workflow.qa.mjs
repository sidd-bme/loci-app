import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

// Synthetic, bounded reviewed-adoption journey. It exercises no protected source data.
const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const outputRoot = process.env.LOCI_QA_OUTPUT_ROOT;
assert.ok(outputRoot && path.isAbsolute(outputRoot), "LOCI_QA_OUTPUT_ROOT must be absolute.");
const relativeOutput = path.relative(projectRoot, outputRoot);
assert.ok(
  relativeOutput.startsWith(`..${path.sep}`) || relativeOutput.startsWith(`.loci${path.sep}`),
  "Keep generated evidence outside Git or under the ignored .loci directory.",
);
const packagedApp = process.env.LOCI_PACKAGED_APP
  ? path.resolve(process.env.LOCI_PACKAGED_APP)
  : null;
const development = process.env.LOCI_QA_DEV === "1";
if (Boolean(packagedApp) === development)
  throw new Error("Set exactly one runtime: LOCI_PACKAGED_APP=/absolute/Loci.app or LOCI_QA_DEV=1.");
if (process.platform !== "darwin")
  throw new Error("The field-assay UI journey currently qualifies macOS Electron builds.");

const executable = packagedApp
  ? path.join(packagedApp, "Contents", "MacOS", "Loci")
  : path.join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const worker = packagedApp
  ? path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const mainArtifact = packagedApp
  ? path.join(packagedApp, "Contents", "Resources", "app.asar")
  : path.join(desktopRoot, ".vite", "build", "main.js");
const python = path.join(projectRoot, "engine", ".venv", "bin", "python");
const startedAt = new Date().toISOString();
const runRoot = path.join(outputRoot, `field-assay-${startedAt.replaceAll(/[:.]/g, "-")}`);
const userData = path.join(runRoot, "user-data");
const fixture = path.join(runRoot, "known-sum-two-channel-two-z.ome.tiff");
const previewScreenshot = path.join(runRoot, "field-assay-preview.png");
const adoptionScreenshot = path.join(runRoot, "field-assay-reviewed-result.png");
const receiptPath = path.join(runRoot, "qa-receipt.json");
await fs.mkdir(userData, { recursive: true });
await Promise.all([fs.access(executable), fs.access(worker), fs.access(mainArtifact), fs.access(python)]);

await run(python, ["-c", String.raw`
from pathlib import Path
import sys
import numpy as np
import tifffile
out=Path(sys.argv[1])
data=np.zeros((1,2,2,8,8),dtype=np.uint16)
data[:,0,:,:,:]=200
data[:,1,:,:,:]=1
data[0,1,0,0:2,0:2]=np.array([[10,20],[5,15]],dtype=np.uint16)
tifffile.imwrite(out,data,ome=True,metadata={'axes':'TCZYX','Channel':{'Name':['DAPI','IL4R-associated Alexa Fluor 555']}})
`, fixture]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const identities = {
  fixture_sha256: await sha256(fixture),
  executable_sha256: await sha256(executable),
  worker_sha256: await sha256(worker),
  main_artifact_sha256: await sha256(mainArtifact),
  harness_sha256: await sha256(import.meta.filename),
};
const pageErrors = [];
const networkRequests = [];
let app;
let launchMs;

async function addAnnotation(page, source, receipt, annotation) {
  return page.evaluate(
    ({ source, receipt, annotation }) => window.lociResearch.execute("annotate_source", {
      source_id: source.id,
      source_sha256: source.sha256,
      expected_revision: receipt.revision,
      action: "add",
      annotation,
    }),
    { source, receipt, annotation },
  );
}

async function waitForFieldAssayResult(page, sourceId) {
  const deadline = performance.now() + 120_000;
  let snapshot;
  while (performance.now() < deadline) {
    snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    const result = snapshot.results.find(
      (item) => item.kind === "field-assay" && item.source_id === sourceId,
    );
    if (result) return { snapshot, result };
    const alert = page.locator(".research-alert[role=alert]");
    if (await alert.isVisible()) throw new Error(`Field assay adoption failed: ${await alert.innerText()}`);
    const failed = snapshot.jobs.find((job) => job.operation === "field_assay_run" && job.state === "failed");
    if (failed) throw new Error(`Field assay adoption failed: ${failed.error}`);
    await page.waitForTimeout(100);
  }
  throw new Error(
    `Reviewed field assay did not appear in the worker snapshot; ${snapshot?.results.length ?? 0} results.`,
  );
}

try {
  const launchStarted = performance.now();
  app = await electron.launch({
    executablePath: executable,
    args: [...(development ? [desktopRoot] : []), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  launchMs = performance.now() - launchStarted;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 900 });
  });
  await app.evaluate(({ dialog }, sourcePath) => {
    dialog.showOpenDialog = async (...args) => args.at(-1)?.title === "Add microscopy or medical images"
      ? { canceled: false, filePaths: [sourcePath] }
      : { canceled: true, filePaths: [] };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, fixture);
  await page.locator("main.image-first-empty, main.research-workbench").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.locator(".research-source-item").waitFor({ state: "visible", timeout: 120_000 });
  const source = await page.evaluate(() => window.lociResearch.getSnapshot().then((state) => state.sources[0]));
  assert.equal(source.sha256, identities.fixture_sha256);
  assert.deepEqual(source.metadata.dimensions, { t: 1, c: 2, z: 2, y: 8, x: 8, s: 1 });

  let annotations = await page.evaluate(
    (sourceId) => window.lociResearch.execute("source_annotations", { source_id: sourceId }),
    source.id,
  );
  const rectangle = (label, z, points) => ({ kind: "rectangle", label, color: "#ffffff", z, t: 0, points });
  annotations = await addAnnotation(page, source, annotations, rectangle("focus", 0, [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
  ]));
  annotations = await addAnnotation(page, source, annotations, rectangle("background", 0, [
    { x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 },
  ]));
  annotations = await addAnnotation(page, source, annotations, rectangle("wrong-plane-control", 1, [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
  ]));
  const focusAnnotation = annotations.annotations.find((item) => item.label === "focus");
  const backgroundAnnotation = annotations.annotations.find((item) => item.label === "background");
  assert.ok(focusAnnotation && backgroundAnnotation, "Synthetic assay ROIs were not saved.");

  await page.getByLabel("Z plane", { exact: true }).focus();
  await page.getByLabel("Z plane", { exact: true }).press("Home");
  await selectWorkbenchTool(page, "Quantify");
  await page.getByRole("button", { name: "Field assay", exact: true }).click();
  const readiness = page.getByLabel("Field assay readiness", { exact: true });
  await readiness.getByText(source.sha256.slice(0, 12), { exact: false }).waitFor();
  await page.getByText("T 0, Z 0", { exact: true }).first().waitFor();
  const focusSelection = page.getByLabel("Focus region selection", { exact: true });
  const backgroundSelection = page.getByLabel("Background annotation selection", { exact: true });
  await focusSelection.locator(`option[value="${focusAnnotation.id}"]`).waitFor({ state: "attached" });
  await backgroundSelection.locator(`option[value="${backgroundAnnotation.id}"]`).waitFor({ state: "attached" });
  await focusSelection.selectOption(focusAnnotation.id);
  await backgroundSelection.selectOption(backgroundAnnotation.id);
  const focusOptions = await focusSelection.locator("option").allTextContents();
  assert.ok(focusOptions.some((text) => text.includes("focus") && text.includes("T 0, Z 0")));
  assert.ok(!focusOptions.some((text) => text.includes("wrong-plane-control")));
  assert.equal(await page.getByText(/Recorded Dr Tan/).count(), 0);
  await page.getByRole("heading", { name: "Fluorescence per nucleus", exact: true }).waitFor();
  await page.getByLabel("Count mode", { exact: true }).selectOption("override");
  await page.getByLabel("Manual count override value", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Preview field assay", exact: true }).click();
  await page.getByRole("heading", { name: "Assay quantification preview", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole("img", { name: /Field assay QC overlay.*T 0, Z 0/ }).waitFor();
  const preview = page.locator(".field-assay-preview-results");
  await preview.getByText("4 px", { exact: true }).waitFor();
  await preview.getByText("50 ADU", { exact: true }).waitFor();
  await preview.getByText("Background ADU", { exact: true }).locator("..").getByText("1", { exact: true }).waitFor();
  await preview.getByText("46 ADU", { exact: true }).first().waitFor();
  await preview.getByText("1 (manual_override)", { exact: true }).waitFor();
  const afterPreview = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(afterPreview.results.length, 0, "Display-only preview unexpectedly adopted a result.");

  for (const label of [
    "Confirm channel identity",
    "Confirm acquisition comparable",
    "Confirm focus reviewed",
    "Confirm nuclei reviewed",
    "Confirm background reviewed",
  ]) await page.getByLabel(label, { exact: true }).check();
  const reviewer = "Synthetic QA Reviewer";
  const assayNotes = "Synthetic known-sum reviewed adoption QA";
  await page.getByLabel("Reviewer name", { exact: true }).fill(reviewer);
  await page.getByLabel("Assay notes", { exact: true }).fill(assayNotes);
  const adopt = page.getByRole("button", { name: "Adopt reviewed field assay", exact: true });
  assert.equal(await adopt.isEnabled(), true, "Complete synthetic review did not enable adoption.");

  await page.getByLabel("Manual threshold", { exact: true }).fill("101");
  await page.getByText(/Configuration changed since preview/).waitFor();
  assert.equal(await adopt.isDisabled(), true,
    "Changing a quantitative setting did not invalidate reviewed adoption.");
  const afterStaleChange = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(afterStaleChange.results.length, 0,
    "A stale preview unexpectedly published a field-assay result.");

  await page.getByRole("button", { name: "Preview field assay", exact: true }).click();
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "Adopt reviewed field assay",
      );
      return button instanceof HTMLButtonElement && !button.disabled &&
        !document.body.textContent?.includes("Configuration changed since preview");
    },
    undefined,
    { timeout: 60_000 },
  );
  const afterReviewedPreview = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(afterReviewedPreview.results.length, 0,
    "Re-preview unexpectedly published a field-assay result.");
  await page.screenshot({ path: previewScreenshot, fullPage: true });

  await adopt.click();
  const adopted = await waitForFieldAssayResult(page, source.id);
  assert.equal(adopted.snapshot.results.length, 1);
  assert.equal(adopted.result.kind, "field-assay");
  assert.equal(adopted.result.source_id, source.id);
  assert.equal(adopted.result.source_sha256, source.sha256);
  assert.match(adopted.result.revision_hash, /^[0-9a-f]{64}$/);
  await page.locator(`[data-result-id="${adopted.result.id}"]`).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  const record = await page.evaluate(
    (resultId) => window.lociResearch.execute("result", { result_id: resultId }),
    adopted.result.id,
  );
  assert.equal(record.result.id, adopted.result.id);
  assert.equal(record.result.revision_hash, adopted.result.revision_hash);
  assert.equal(record.result.source_id, source.id);
  assert.equal(record.result.source_sha256, source.sha256);
  assert.equal(record.result.kind, "field-assay");
  assert.deepEqual(record.provenance.selection, {
    x: 0, y: 0, width: 8, height: 8, z: 0, c: 1, t: 0, level: 0,
  });
  assert.equal(record.provenance.schema, "loci.field-assay-result/v1");
  assert.equal(record.provenance.source_id, source.id);
  assert.equal(record.provenance.source_sha256, source.sha256);
  assert.equal(record.provenance.nuclei_channel, 0);
  assert.equal(record.provenance.signal_channel, 1);
  assert.equal(record.provenance.z, 0);
  assert.equal(record.provenance.t, 0);
  assert.equal(record.provenance.focus_source, `source_annotation:${focusAnnotation.id}`);
  assert.equal(record.provenance.background_source, `source_annotation:${backgroundAnnotation.id}`);
  assert.equal(record.provenance.reviewer, reviewer);
  assert.equal(record.provenance.assay_notes, assayNotes);
  const summary = record.provenance.summary;
  assert.equal(summary.focus_pixels, 4);
  assert.equal(summary.effective_measurement_pixels, 4);
  assert.equal(summary.raw_signal_sum_adu, 50);
  assert.equal(summary.background_value_adu, 1);
  assert.equal(summary.integrated_signal_minus_background_adu, 46);
  assert.equal(summary.reviewed_nuclei_count, 1);
  assert.equal(summary.count_mode, "manual_override");
  assert.equal(summary.field_ratio_integrated_signal_per_accepted_nucleus_adu, 46);
  assert.equal(summary.endpoint_status, "reviewed");
  assert.equal(record.provenance.config.nuclear_threshold, 101);
  assert.equal(record.provenance.config.endpoint_status, "reviewed");
  assert.equal(record.provenance.config.reviewer, reviewer);
  for (const key of [
    "channel_identity_confirmed",
    "acquisition_comparable",
    "focus_reviewed",
    "nuclei_reviewed",
    "background_reviewed",
  ]) assert.equal(record.provenance.config[key], true, `${key} was not preserved.`);
  assert.deepEqual(
    await page.evaluate(
      (resultId) => window.lociResearch.execute("result", { result_id: resultId }),
      adopted.result.id,
    ),
    record,
    "A second read changed the immutable result record.",
  );
  await page.screenshot({ path: adoptionScreenshot, fullPage: true });
  assert.equal(await page.locator(".research-alert[role=alert]").isVisible(), false,
    "The adopted result left a source-view or analysis error visible.");
  assert.deepEqual(await Promise.all([sha256(fixture), sha256(executable), sha256(worker), sha256(mainArtifact)]),
    [identities.fixture_sha256, identities.executable_sha256, identities.worker_sha256,
      identities.main_artifact_sha256], "Source or packaged artifacts changed during the assay journey.");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(networkRequests, []);
  await fs.writeFile(receiptPath, JSON.stringify({
    schema: "loci.field-assay-ui-qa/v1",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    runtime: development ? "development" : "packaged",
    launch_ms: launchMs,
    launch_measurement: "Process launch to first Electron window; recorded separately from functional assay acceptance.",
    identities,
    source: { id: source.id, sha256: source.sha256, dimensions: source.metadata.dimensions },
    annotation_revision: annotations.revision,
    assertions: {
      active_plane: { t: 0, z: 0 },
      wrong_plane_roi_hidden: true,
      focus_pixels: 4,
      raw_signal_sum_adu: 50,
      background_value_adu: 1,
      signed_corrected_total_adu: 46,
      manual_count: 1,
      preview_did_not_adopt: true,
      setting_change_invalidated_adoption: true,
      reviewed_adoption: {
        reviewer,
        result_id: adopted.result.id,
        revision_hash: adopted.result.revision_hash,
        source_id: adopted.result.source_id,
        source_sha256: adopted.result.source_sha256,
        endpoint_status: summary.endpoint_status,
        threshold_adu: record.provenance.config.nuclear_threshold,
      },
      immutable_result_second_read_equal: true,
      source_and_build_bytes_unchanged: true,
      no_visible_analysis_or_source_view_error: true,
      network_requests: networkRequests,
    },
    screenshots: {
      reviewed_preview: {
        file: path.basename(previewScreenshot),
        sha256: await sha256(previewScreenshot),
      },
      adopted_result: {
        file: path.basename(adoptionScreenshot),
        sha256: await sha256(adoptionScreenshot),
      },
    },
  }, null, 2) + "\n");
  console.log(`Field-assay UI QA passed: ${receiptPath}`);
} catch (error) {
  const failureScreenshot = path.join(runRoot, "failure.png");
  const window = app ? await app.firstWindow().catch(() => null) : null;
  if (window) await window.screenshot({ path: failureScreenshot }).catch(() => undefined);
  await fs.writeFile(path.join(runRoot, "qa-failure.json"), JSON.stringify({
    status: "failed", started_at: startedAt, failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    identities, launch_ms: launchMs, page_errors: pageErrors, network_requests: networkRequests,
  }, null, 2) + "\n");
  throw error;
} finally {
  if (app) {
    const closed = app.waitForEvent("close", { timeout: 30_000 });
    await app.evaluate(({ app }) => app.quit());
    await closed;
  }
}
