import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

// All mutations below use visible controls in the actual packaged application.
// Read-only snapshots and result inspection provide numerical assertions against
// those actions, without inserting results or replacing the worker transport.
export async function qualifyExtendedWorkflows({
  app, page, runRoot, fixture, noUiError, screenshot,
}) {
  const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
  const inspect = (id) => page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id }), id,
  );
  const tools = new Set(["Display", "Annotate", "Correction", "Process", "Analyze",
    "Quantify", "Temporal", "Registration", "Agent", "Remote", "Model", "Study",
    "Portability", "Info"]);
  const tab = (name) => tools.has(name) ? selectWorkbenchTool(page, name)
    : page.getByRole("button", { name, exact: true }).click();
  const openAnalysisRegion = async () => {
    const details = page.locator("details.analysis-region-settings");
    if (!await details.evaluate((element) => element.open)) {
      await details.locator("summary").click();
    }
  };
  const wait = async (read, predicate, label, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await noUiError(page, label);
      const value = await read();
      if (predicate(value)) return value;
      await page.waitForTimeout(200);
    }
    throw new Error("No verified completion for " + label);
  };
  const newResult = async (action, kind) => {
    const before = new Set((await snapshot()).results.map((item) => item.id));
    await action();
    const state = await wait(snapshot, (value) => value.results.some(
      (item) => !before.has(item.id) && (!kind || item.kind === kind),
    ), kind ?? "new result");
    const result = state.results.find(
      (item) => !before.has(item.id) && (!kind || item.kind === kind),
    );
    await wait(
      async () => page.locator(`[data-result-id="${result.id}"]`).getAttribute("class"),
      (value) => value?.includes("selected"),
      `open published ${kind ?? "result"} revision`,
    );
    return result;
  };
  const openResult = async (result) => {
    const state = await snapshot();
    const source = state.sources.find((item) => item.id === result.source_id);
    await page.locator(".research-sources").getByRole("button", {
      name: new RegExp("^" + source.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    }).click();
    await page.locator(`[data-result-id="${result.id}"]`).click();
    await wait(async () => page.locator(`[data-result-id="${result.id}"]`).getAttribute("class"),
      (value) => value?.includes("selected"), "select exact revision");
  };
  const paths = {
    access: path.join(runRoot, "bounded-agent-access"),
    archive: path.join(runRoot, "portable-study.zip"),
    imported: path.join(runRoot, "imported-study.loci-study"),
    template: path.join(runRoot, "reusable-recipe.json"),
    roiExport: path.join(runRoot, "reviewed-roi"),
  };
  await app.evaluate(({ dialog }, values) => {
    const open = dialog.showOpenDialog;
    const save = dialog.showSaveDialog;
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const destinations = {
        "Create private MCP access bundle": values.access,
        "Export portable study with derived results": values.archive,
        "Choose a new study directory": values.imported,
        "Export reusable recipe template": values.template,
        "Export reviewed result bundle": values.roiExport,
      };
      return title in destinations
        ? { canceled: false, filePath: destinations[title] } : save(...args);
    };
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      const sources = {
        "Import portable Loci study": values.archive,
        "Import reusable recipe template": values.template,
        "Relink an exact local copy of the source": values.multiplex,
      };
      return title in sources
        ? { canceled: false, filePaths: [sources[title]] } : open(...args);
    };
  }, { ...paths, multiplex: fixture.multiplex });

  const initial = await snapshot();
  const volumeSource = initial.sources.find((item) => item.name === path.basename(fixture.volume));
  assert.ok(volumeSource, "The anisotropic microscopy reference source must be present");
  const original = initial.results.find(
    (item) => item.source_id === volumeSource.id && item.kind === "segmentation" &&
      item.arrays.labels?.shape.length === 3,
  );
  assert.ok(original, "The initial 3D result must exist before extended correction QA");
  await openResult(original);
  await tab("Correction");
  await page.getByLabel("Correction label", { exact: true }).selectOption("1");
  const deleted = await newResult(() => tab("Delete selected label"));
  assert.equal(deleted.object_count, 1);
  assert.equal(deleted.parent_id, original.id);
  await tab("Undo revision");
  await wait(async () => page.locator(`[data-result-id="${original.id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"), "3D correction undo");
  await tab("Redo revision");
  await wait(async () => page.locator(`[data-result-id="${deleted.id}"]`).getAttribute("class"),
    (value) => value?.includes("selected"), "3D correction redo");
  await page.getByRole("button", { name: "Surface", exact: true }).click();
  await page.getByLabel("Surface basis").selectOption("labels");
  await page.getByLabel("Surface label ID").fill("2");
  await tab("Build surface");
  const surface = page.getByLabel(/^Interactive world-coordinate surface/);
  await surface.waitFor({ state: "visible" });
  await surface.press("ArrowRight");
  await surface.press("+");
  await screenshot(page, "extended-3d-correction-surface");
  await page.getByRole("button", { name: "Surface", exact: true }).click();

  await page.locator(".research-sources").getByRole("button", {
    name: /^multiplex_translating_objects\.ome\.tiff/,
  }).click();
  await tab("Display");
  await openAnalysisRegion();
  await page.getByLabel("C", { exact: true }).fill("0");
  await page.getByLabel("T", { exact: true }).fill("0");
  await page.getByLabel("Z", { exact: true }).fill("2");
  // Explicitly select the complete reference field. The prior source's 40x32
  // crop is a valid retained scope but excludes the second translating object.
  for (const [label, value] of [["X", "0"], ["Y", "0"], ["Width", "64"], ["Height", "48"]])
    await page.getByLabel(label, { exact: true }).fill(value);
  await tab("Quantify");
  await page.getByLabel("Channel 1 name", { exact: true }).fill("Declared nuclei");
  await page.getByLabel("Channel 1 declaration", { exact: true }).fill("Synthetic QA channel declaration");
  await page.getByLabel("Channel 2 name", { exact: true }).fill("Declared reporter");
  await page.getByRole("button", { name: /^Save declarations at revision/ }).click();
  await wait(snapshot, (state) => state.channels.some((item) =>
    item.data?.channels?.[0]?.name === "Declared nuclei"), "channel metadata save");

  const frames = [];
  for (const time of [0, 1, 2]) {
    if (time) {
      await tab("Show source");
      await tab("Display");
      await openAnalysisRegion();
      await page.getByLabel("T", { exact: true }).fill(String(time));
    }
    await tab("Analyze");
    await page.getByLabel("Threshold", { exact: true }).fill("50");
    const result = await newResult(() => tab("Run recipe"));
    const record = await inspect(result.id);
    assert.deepEqual(record.measurements.map((item) => item.measure), [18, 18]);
    frames.push(result);
  }
  await tab("Temporal");
  for (const frame of frames) {
    const candidate = page.locator(".research-temporal .research-compact-list > div")
      .filter({ hasText: frame.id.slice(0, 8) });
    await candidate.getByRole("button", { name: "Add frame" }).click();
  }
  for (let index = 0; index < frames.length; index++)
    assert.equal(await page.getByLabel(`Frame ${index + 1} elapsed seconds`).inputValue(), String(index * 5));
  await page.getByLabel("Confirm actual elapsed seconds").check();
  const tracked = await newResult(() => tab("Create temporal graph"), "temporal-tracking");
  const graph = await page.evaluate((result) => window.lociResearch.execute("tracking_result", {
    result_id: result.id, revision_hash: result.revision_hash,
  }), tracked);
  assert.equal(graph.tracking.edges.length, 4);
  for (const trajectory of graph.tracking.trajectories) {
    assert.equal(trajectory.length, 3);
    for (const point of trajectory.slice(1)) assert.ok(Math.abs(point.speed - 0.1) < 1e-12);
  }
  await page.getByLabel("Association to remove").selectOption("0");
  const correctedTracks = await newResult(() => tab("Publish corrected graph revision"), "temporal-tracking");
  assert.equal(correctedTracks.parent_id, tracked.id);
  await screenshot(page, "extended-temporal-association-correction");

  await tab("Registration");
  await page.getByLabel("Registration fixed result").selectOption(frames[0].id);
  await page.getByLabel("Registration moving result").selectOption(frames[1].id);
  await page.getByLabel("Include moving labels").check();
  await tab("Preview exact registration");
  await page.getByLabel("Exact registration preview").waitFor({ state: "visible" });
  const registered = await newResult(() => tab("Adopt this exact receipt"), "registered-derived");
  const registration = await inspect(registered.id);
  assert.equal(registration.provenance.derived_measurement_arrays[0], "image");
  await screenshot(page, "extended-registration");
  await page.getByRole("tab", { name: "Resample grid" }).click();
  await page.getByLabel("Grid parent result").selectOption(frames[0].id);
  await page.getByLabel("Grid output shape").fill("24, 32");
  await page.getByLabel("Grid physical spacing").fill("2, 1");
  await page.getByLabel("Include parent labels").check();
  const resampled = await newResult(() => tab("Publish declared output grid"), "resampled-derived");
  assert.deepEqual(resampled.arrays.labels.shape, [24, 32]);

  await openResult(frames[0]);
  await tab("Show source");
  await tab("Display");
  await openAnalysisRegion();
  await page.getByLabel("T", { exact: true }).fill("0");
  await page.getByLabel("Z", { exact: true }).fill("2");
  await tab("Quantify");
  await tab("colocalisation");
  await page.getByLabel("First colocalisation channel").selectOption("0");
  await page.getByLabel("Second colocalisation channel").selectOption("1");
  await page.getByLabel("First colocalisation threshold").fill("50");
  await page.getByLabel("Second colocalisation threshold").fill("100");
  await page.getByLabel("Colocalisation controls and assumptions").fill("Exact proportional synthetic channels; technical QA only.");
  const coloc = await newResult(() => tab("Run and adopt colocalisation"), "colocalisation");
  const colocRecord = await inspect(coloc.id);
  assert.ok(JSON.stringify(colocRecord.provenance).includes("Exact proportional synthetic channels"));
  await tab("puncta");
  await page.getByLabel("Physical LoG sigma").fill("2");
  await page.getByLabel("LoG response threshold").fill("1");
  await page.getByLabel("Raw intensity threshold").fill("50");
  await page.getByLabel("Physical minimum distance").fill("8");
  await page.getByLabel("Physical aperture radius").fill("1");
  await page.getByLabel("Puncta control and assumptions").fill("Synthetic flat objects test candidate publication; no puncta accuracy claim.");
  await tab("Preview puncta candidates");
  const puncta = await newResult(() => tab("Adopt unchanged puncta request"), "puncta-quantification");
  assert.ok(puncta.object_count > 0);
  await screenshot(page, "extended-puncta");

  await tab("association");
  await page.getByLabel("Nuclei result").selectOption(puncta.id);
  await page.getByLabel("Cells result").selectOption(frames[0].id);
  await page.getByLabel("Association controls and assumptions").fill(
    "Synthetic fields on the same exact grid; descriptive association QA only.",
  );
  const association = await newResult(
    () => tab("Associate exact revisions"), "nucleus-cell-association",
  );
  const associationRecord = await inspect(association.id);
  assert.equal(association.parent_id, frames[0].id);
  assert.equal(associationRecord.provenance.association_inputs.nuclei.result_id, puncta.id);
  assert.equal(associationRecord.provenance.association_inputs.cells.result_id, frames[0].id);
  assert.equal(
    associationRecord.provenance.association.control,
    "Synthetic fields on the same exact grid; descriptive association QA only.",
  );

  // Draw a real single-plane ROI, export both interoperable forms, then import
  // each through the visible file input against the exact bound parent.
  await openResult(frames[0]);
  await tab("Correction");
  await page.getByLabel("Correction tool").selectOption("roi");
  await page.getByLabel("ROI ID").fill("qa-roi");
  await page.getByText("Loading the selected exact plane…").waitFor({ state: "hidden" });
  const overlayCanvas = page.locator(".image-viewport canvas");
  const standaloneImage = page.getByAltText("Exact selected result revision");
  const isOverlay = await overlayCanvas.isVisible();
  const targetSurface = isOverlay ? overlayCanvas : standaloneImage;
  await targetSurface.waitFor({ state: "visible" });
  const bounds = await targetSurface.boundingBox();
  assert.ok(bounds, "Interactive result surface must be measurable for ROI drawing");
  for (const [x, y] of [[0.4, 0.4], [0.6, 0.4], [0.5, 0.6]]) {
    await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    await page.waitForTimeout(100);
  }
  if (!isOverlay) {
    await page.getByLabel("Polygon preview in voxel coordinates").waitFor({ state: "visible" });
  }
  await wait(
    () => page.getByRole("button", { name: "Add measured ROI" }).isEnabled(),
    Boolean,
    "Add measured ROI enabled",
  );
  assert.equal(await page.getByRole("button", { name: "Add measured ROI" }).isEnabled(), true);
  const roi = await newResult(() => tab("Add measured ROI"), "annotated-result");
  const roiRecord = await inspect(roi.id);
  assert.equal(roi.parent_id, frames[0].id);
  assert.equal(roiRecord.provenance.annotations[0].id, "qa-roi");
  await tab("Info");
  await tab("Mark reviewed");
  await wait(snapshot, (state) => state.results.some((item) =>
    item.id === roi.id && item.review?.disposition === "reviewed"), "review ROI revision");
  await tab("Export revision");
  const geojsonPath = path.join(paths.roiExport, "annotations.geojson");
  const imagejPath = path.join(paths.roiExport, "annotation-qa-roi.roi");
  await wait(
    async () => Promise.all(
      [geojsonPath, imagejPath].map((file) => fs.stat(file).catch(() => null)),
    ),
    (files) => files.every((file) => file?.size > 0),
    "GeoJSON and ImageJ ROI export",
  );

  const importAnnotation = async (file, format) => {
    await openResult(frames[0]);
    await tab("Portability");
    const input = page.getByLabel("Annotation file");
    await page.getByLabel("Annotation format").selectOption(format);
    await input.setInputFiles(file);
    const imported = await newResult(() => tab("Import into new revision"), "annotated-result");
    assert.equal(imported.parent_id, frames[0].id);
    return imported;
  };
  const importedGeojson = await importAnnotation(geojsonPath, "geojson");
  const importedImagej = await importAnnotation(imagejPath, "imagej");
  assert.equal(
    (await inspect(importedGeojson.id)).provenance.annotations[0].interchange.format,
    "geojson",
  );
  assert.equal(
    (await inspect(importedImagej.id)).provenance.annotations[0].interchange.format,
    "imagej",
  );
  await screenshot(page, "extended-roi-interchange");

  // Native bundle creation is exercised with all disclosure categories denied.
  await tab("Show source");
  await tab("Agent");
  await tab("Validate exact scope and recipe");
  await wait(() => page.getByLabel("Exact recipe validation").isVisible(),
    Boolean, "exact agent recipe validation", 30_000);
  for (const input of await page.locator('input[aria-label^="Disclose "]').all())
    assert.equal(await input.isChecked(), false);
  await page.getByLabel("Confirm exact agent policy").check();
  await tab("Create bounded agent access");
  await wait(() => page.getByLabel("Created agent access receipt").isVisible(),
    Boolean, "bounded agent access receipt", 30_000);
  const accessFiles = await fs.readdir(paths.access);
  assert.ok(accessFiles.includes("mcp-config.json"));
  await screenshot(page, "extended-agent-policy");

  await tab("Portability");
  await tab("Export template");
  await wait(
    () => fs.stat(paths.template).catch(() => null),
    (file) => file?.size > 0,
    "recipe template export",
  );
  await tab("Choose template and import");
  await wait(snapshot, (state) => state.recipes.length >= 2, "recipe template import");
  await tab("Export portable study");
  await wait(async () => fs.stat(paths.archive).catch(() => null), (value) => value?.size > 0, "portable study export");
  const beforeImport = await snapshot();
  await tab("Import portable study");
  const imported = await wait(snapshot, (state) => state.sources.every(
    (item) => item.locator_state === "relink-required"), "portable study import");
  assert.deepEqual(imported.results.map((item) => item.revision_hash).sort(),
    beforeImport.results.map((item) => item.revision_hash).sort());
  const missing = page.locator(".research-portability-list li").filter({
    hasText: "multiplex_translating_objects.ome.tiff",
  });
  await missing.getByRole("button", { name: "Relink exact source" }).click();
  await wait(snapshot, (state) => state.sources.some((item) =>
    item.name === "multiplex_translating_objects.ome.tiff" && item.locator_state !== "relink-required"), "exact source relink");
  await screenshot(page, "extended-imported-study-relink");
  await tab("Open study");
  await wait(snapshot, (state) =>
    state.sources.length === beforeImport.sources.length &&
    state.sources.every((item) => item.locator_state !== "relink-required") &&
    JSON.stringify(state.results.map((item) => item.revision_hash).sort()) ===
      JSON.stringify(beforeImport.results.map((item) => item.revision_hash).sort()),
  "reopen original study through visible UI");
  return {
    status: "passed", original3d: original.id, corrected3d: deleted.id,
    temporal: tracked.id, correctedTracks: correctedTracks.id,
    registered: registered.id, resampled: resampled.id,
    colocalisation: coloc.id, puncta: puncta.id, association: association.id,
    roi: roi.id, importedGeojson: importedGeojson.id, importedImagej: importedImagej.id,
    frameResults: frames.map((item) => item.id),
    portableRevisionHashesPreserved: true, exactRelink: true,
    agentAccessFiles: accessFiles,
  };
}
