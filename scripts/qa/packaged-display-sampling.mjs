/** Real macOS package QA. See LOCI_QA_* settings below. Only generated images enter the profile. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { placeQaWindow } from "./display-placement.mjs";
import { selectWorkbenchTool, sourceRowByName, waitForSnapshot } from "../../desktop/tests/workbench-qa-helpers.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const desktop = path.join(repo, "desktop");
const { _electron: electron } = createRequire(path.join(desktop, "package.json"))("playwright");
const run = promisify(execFile);
const env = process.env;
assert.equal(process.platform, "darwin", "Use a packaged macOS candidate");
assert.equal(process.versions.node.split(".")[0], "24", "Use Node 24");

function absolute(name) {
  assert.ok(path.isAbsolute(env[name] ?? ""), `${name} must be absolute`);
  return env[name];
}

const bundle = absolute("LOCI_PACKAGED_APP");
const outputRoot = absolute("LOCI_QA_OUTPUT_ROOT");
const python = absolute("LOCI_QA_PYTHON");
const sourceCommit = env.LOCI_QA_SOURCE_COMMIT;
assert.match(sourceCommit ?? "", /^[a-f0-9]{40}$/u, "Set LOCI_QA_SOURCE_COMMIT");
const seamsOnly = env.LOCI_QA_SEAMS_ONLY === "1";
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, "display-sampling-"));
const artifacts = {
  executable: path.join(bundle, "Contents/MacOS/Loci"),
  asar: path.join(bundle, "Contents/Resources/app.asar"),
  worker: path.join(bundle, "Contents/Resources/loci-engine/loci-engine"),
  identity: path.join(bundle, "Contents/Resources/loci-build-identity.json"),
};
const receipt = {
  schema: "loci.packaged-display-sampling-qa/v1",
  status: "running",
  stage: "identity",
  started_at: new Date().toISOString(),
  node: process.version,
  output,
  bundle,
  seams_only: seamsOnly,
  checks: [],
  renderer_errors: [],
  screenshots: {},
  limits: ["Synthetic software QA. The macOS picker response is simulated; import, raster rendering and controls are real."],
};
const save = () => fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
const sha256 = async (file) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
};
const artifactHashes = async () => Object.fromEntries(await Promise.all(
  Object.entries(artifacts).map(async ([name, file]) => [name, await sha256(file)]),
));
let app, page;
const button = (root, name) => root.getByRole("button", { name, exact: true });
const viewer = (id) => page.locator(`.image-viewport[data-controls="docked"][data-viewer-source="${id}"]`);
const readout = (view) => view.locator('[aria-label="Image dimensions and display sampling"]');
const twoFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  receipt.screenshots[name] = { file, sha256: await sha256(file) };
}

async function chooseMode(view, label, mode, keyboard = false) {
  const group = view.getByRole("group", { name: "Display sampling", exact: true });
  const selected = button(group, label);
  if (keyboard) await selected.press("Enter");
  else await selected.click();
  assert.equal(await selected.getAttribute("aria-pressed"), "true");
  assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
  assert.equal(await view.getAttribute("data-display-sampling"), mode);
}

async function ready(view) {
  // The test image has four 512-square native tiles and one 1024-square
  // overview. An overview-only paint cannot satisfy the decoded-byte floor.
  await view.and(page.locator('[data-prepared="true"][data-auto-level="0"]')).waitFor();
  const deadline = Date.now() + 30_000;
  while (Number(await view.getAttribute("data-cache-bytes")) < 8 * 1024 ** 2) {
    assert.ok(Date.now() < deadline, "Expected all four native tiles and the overview");
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  await twoFrames();
}

async function raster(view) {
  return view.evaluate(element => {
    const canvas = element.querySelector('canvas[aria-label="Source image and bound annotations"]');
    const context = canvas.getContext("2d");
    const camera = JSON.parse(element.dataset.camera);
    const bounds = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const physicalScale = camera.scale * dpr;
    const seam = {
      x: (bounds.width / 2 + (512 - camera.x) * camera.scale) * dpr,
      y: (bounds.height / 2 + (512 - camera.y) * camera.scale) * dpr,
    };
    const parallel = {
      x: Math.floor(seam.x - 16 * physicalScale),
      y: Math.floor(seam.y - 16 * physicalScale),
    };
    const strips = {};
    for (const axis of ["x", "y"]) {
      const horizontal = axis === "x";
      const first = Math.floor(seam[axis]) - 8;
      const orthogonal = horizontal ? parallel.y : parallel.x;
      const startX = horizontal ? first : orthogonal;
      const startY = horizontal ? orthogonal : first;
      const length = 17;
      if (startX < 0 || startY < 0 || startX + (horizontal ? length : 1) > canvas.width ||
          startY + (horizontal ? 1 : length) > canvas.height) {
        throw new Error(`Authored seam did not fit backing canvas at ${JSON.stringify({ axis, startX, startY, camera })}`);
      }
      const pixels = context.getImageData(startX, startY, horizontal ? length : 1, horizontal ? 1 : length).data;
      const actual = Array.from({ length }, (_, index) => pixels[4 * index]);
      // Independent contiguous stripe with the same plateau colors and phase.
      // Build in the direction of the sampled axis, making the other axis constant.
      const strip = new OffscreenCanvas(32, 1);
      const stripContext = strip.getContext("2d");
      stripContext.fillStyle = `rgb(${actual[0]}, 0, 0)`;
      stripContext.fillRect(0, 0, 16, 1);
      stripContext.fillStyle = `rgb(${actual.at(-1)}, 0, 0)`;
      stripContext.fillRect(16, 0, 16, 1);
      const reference = new OffscreenCanvas(length, 1).getContext("2d", { alpha: false });
      reference.imageSmoothingEnabled = true;
      reference.drawImage(strip, seam[axis] - first - 16 * physicalScale, 0, 32 * physicalScale, 1);
      const expected = reference.getImageData(0, 0, length, 1).data;
      strips[axis] = {
        source_edge: 512,
        first_backing_pixel: first,
        orthogonal_backing_pixel: orthogonal,
        actual,
        contiguous_smooth_reference: Array.from({ length }, (_, index) => expected[4 * index]),
      };
    }
    return {
      camera, dpr, physical_scale: physicalScale, canvas: [canvas.width, canvas.height],
      source: element.dataset.viewerSource, cache_bytes: Number(element.dataset.cacheBytes),
      level: Number(element.dataset.autoLevel), effective: element.dataset.effectiveSampling, strips,
    };
  });
}

function binding(sample) {
  const { camera, dpr, canvas, source, level } = sample;
  return { camera, dpr, canvas, source, level };
}

function rasterValues(sample) {
  return Object.values(sample.strips).map(strip => strip.actual);
}

try {
  await save();
  const identity = JSON.parse(await fs.readFile(artifacts.identity, "utf8"));
  const { stdout: tree } = await run("git", ["rev-parse", `${sourceCommit}^{tree}`], { cwd: repo });
  assert.equal(identity.sourceRevision, sourceCommit, "Packaged commit mismatch");
  assert.equal(identity.sourceTree, tree.trim(), "Packaged tree mismatch");
  assert.equal(identity.sourceDirty, false);
  receipt.build = { identity, artifacts: await artifactHashes(), harness_sha256: await sha256(import.meta.filename) };
  const signature = await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle], { timeout: 120_000 });
  receipt.signature = { status: "passed", output: signature.stderr.trim() };
  receipt.stage = "fixtures";
  const generator = path.join(output, "generate-fixture.py");
  await fs.writeFile(generator, `from pathlib import Path
import sys

import numpy as np
import tifffile

output = Path(sys.argv[1])
y, x = np.ogrid[:1024, :1024]
for index, name in enumerate(("sampling-a.ome.tif", "sampling-b.ome.tif")):
    pixels = (110 * (x >= 512) + 140 * (y >= 512)).astype(np.uint8)
    pixels[0, 0] = index
    tifffile.imwrite(output / name, pixels, ome=True, photometric="minisblack",
                     metadata={"axes": "YX"})
`);
  const fixtures = ["sampling-a.ome.tif", "sampling-b.ome.tif"].map(name => path.join(output, name));
  await run(python, [generator, output], { timeout: 30_000 });
  receipt.fixture = {
    shape: [1024, 1024], axes: "YX", vertical_and_horizontal_edges: 512,
    generator_sha256: await sha256(generator), sources: await Promise.all(fixtures.map(sha256)),
  };
  assert.notEqual(...receipt.fixture.sources);

  receipt.stage = "launch-and-import";
  const profile = path.join(output, "profile");
  app = await electron.launch({
    executablePath: artifacts.executable, args: [`--user-data-dir=${profile}`], cwd: desktop,
    env: { ...env, LOCI_MODEL_HOME: path.join(profile, "models") }, timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => receipt.renderer_errors.push(error.message));
  await placeQaWindow(app, { requestedDisplay: env.LOCI_QA_SECONDARY_DISPLAY, launch: 1 }, receipt);
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== "Add microscopy or medical images") throw new Error(`Unexpected picker: ${title}`);
      return { canceled: false, filePaths: files };
    };
  }, fixtures);
  await button(page, "Open images").click();
  const snapshot = await waitForSnapshot(page, state => receipt.fixture.sources.every(sha =>
    state?.sources.some(item => item.sha256 === sha)), "two generated sources");
  assert.equal(snapshot.sources.length, 2);
  const [sourceA, sourceB] = receipt.fixture.sources.map(sha => snapshot.sources.find(item => item.sha256 === sha));
  receipt.source_bindings = [sourceA, sourceB].map(({ id, name, sha256: sha }) => ({ id, name, sha256: sha }));
  await (await sourceRowByName(page, sourceA.name)).click();
  const main = viewer(sourceA.id);
  await ready(main);

  receipt.stage = "magnified-seams";
  await button(main, "1:1").click();
  assert.equal(await main.getByLabel("Native pixel zoom").textContent(), "100%");
  assert.equal(await main.getAttribute("data-effective-sampling"), "nearest");
  for (let step = 0; step < 5; step++) await button(main, "Zoom in").click();
  await ready(main);
  const auto = await raster(main);
  assert.equal(auto.effective, "nearest");
  assert.ok(auto.physical_scale > 2.5 && auto.physical_scale < 4);
  await chooseMode(main, "Nearest pixel", "nearest", true);
  await twoFrames();
  const nearest = await raster(main);
  await screenshot("magnified-nearest");
  await chooseMode(main, "Smooth", "smooth");
  await twoFrames();
  const smooth = await raster(main);
  await screenshot("magnified-smooth");
  receipt.checks.push({ name: "magnified-tile-seams", auto, nearest, smooth });
  await save();
  assert.equal(smooth.effective, "smooth");
  assert.match(await readout(main).textContent(), /Beyond native · smoothed/);
  assert.deepEqual(binding(auto), binding(nearest));
  assert.deepEqual(binding(nearest), binding(smooth));
  assert.deepEqual(rasterValues(auto), rasterValues(nearest), "Auto above native size must match Nearest");

  const mismatches = [];
  for (const axis of ["x", "y"]) {
    const hard = nearest.strips[axis].actual;
    const soft = smooth.strips[axis].actual;
    const reference = smooth.strips[axis].contiguous_smooth_reference;
    assert.ok(hard.at(-1) - hard[0] >= 40, `${axis} fixture edge lacks contrast`);
    assert.deepEqual(soft.filter((_, index) => index === 0 || index === soft.length - 1), [hard[0], hard.at(-1)],
      `${axis} plateau colors must be mode independent`);
    assert.ok(hard.every(value => value === hard[0] || value === hard.at(-1)), `${axis} Nearest is not a hard step`);
    assert.ok(reference.some(value => value > hard[0] + 5 && value < hard.at(-1) - 5), `${axis} reference has no resolved transition`);
    const maxDelta = Math.max(...soft.map((value, index) => Math.abs(value - reference[index])));
    if (maxDelta > 3) mismatches.push(`${axis}: max error ${maxDelta} gray levels`);
  }
  assert.deepEqual(mismatches, [], "Smooth must match the contiguous source reference across both native tile edges");

  if (!seamsOnly) {
    receipt.stage = "reduced-auto";
    await button(main, "1:1").click();
    await button(main, "Zoom out").click();
    await chooseMode(main, "Auto", "auto");
    await ready(main);
    const reducedAuto = await raster(main);
    assert.ok(reducedAuto.physical_scale < 1);
    assert.equal(reducedAuto.effective, "smooth");
    assert.match(await readout(main).textContent(), /Reduced · smoothed/);
    await chooseMode(main, "Smooth", "smooth");
    await twoFrames();
    const reducedSmooth = await raster(main);
    assert.deepEqual(binding(reducedAuto), binding(reducedSmooth));
    assert.deepEqual(rasterValues(reducedAuto), rasterValues(reducedSmooth));
    receipt.checks.push({ name: "reduced-auto-matches-smooth", reducedAuto, reducedSmooth });

    receipt.stage = "annotation-tool";
    await selectWorkbenchTool(page, "Annotate");
    await button(page, "Point").click();
    await ready(main);
    assert.equal(await main.getAttribute("data-display-sampling"), "smooth", "Switching annotation tool reset the main mode");
    const target = await main.evaluate(element => {
      const canvas = element.querySelector('canvas[aria-label="Source image and bound annotations"]');
      const bounds = canvas.getBoundingClientRect();
      const { x, y, scale } = JSON.parse(element.dataset.camera);
      const screenX = Math.round(bounds.x + bounds.width / 2);
      const screenY = Math.round(bounds.y + bounds.height / 2);
      return { screenX, screenY, hitsCanvas: document.elementFromPoint(screenX, screenY) === canvas,
        x: x + (screenX - bounds.x - bounds.width / 2) / scale,
        y: y + (screenY - bounds.y - bounds.height / 2) / scale };
    });
    assert.ok(target.hitsCanvas, "Annotation target is obstructed");
    await page.mouse.click(target.screenX, target.screenY);
    await chooseMode(main, "Nearest pixel", "nearest");
    await page.getByLabel("Annotation label", { exact: true }).fill("Sampling QA point");
    await button(page, "Save annotation").click();
    await page.getByText("1 saved", { exact: true }).waitFor();
    const annotationState = await page.evaluate(id =>
      window.lociResearch.execute("source_annotations", { source_id: id }), sourceA.id);
    assert.equal(annotationState.source_sha256, sourceA.sha256);
    assert.equal(annotationState.annotations.length, 1);
    const annotation = annotationState.annotations[0];
    assert.equal(annotation.kind, "point");
    assert.equal(annotation.points.length, 1);
    for (const axis of ["x", "y"]) {
      assert.ok(Math.abs(annotation.points[0][axis] - target[axis]) < 0.1, `Sampling changed annotation ${axis}`);
    }
    await chooseMode(main, "Smooth", "smooth");
    receipt.checks.push({ name: "annotation-mode-and-geometry", source: sourceA.id, target, annotation });
    await selectWorkbenchTool(page, "Display");

    receipt.stage = "comparison";
    await button(page, "Compare A/B").click();
    const paneA = viewer(sourceA.id);
    const paneB = viewer(sourceB.id);
    await ready(paneA);
    await ready(paneB);
    assert.equal(await paneA.getAttribute("data-display-sampling"), "auto");
    assert.equal(await paneB.getAttribute("data-display-sampling"), "auto");
    await chooseMode(paneA, "Smooth", "smooth");
    assert.equal(await paneB.getAttribute("data-display-sampling"), "auto");
    await chooseMode(paneB, "Nearest pixel", "nearest");
    assert.equal(await paneA.getAttribute("data-display-sampling"), "smooth");
    await screenshot("comparison-independent-modes");
    receipt.checks.push({ name: "comparison-modes-independent", source_a: sourceA.id, source_b: sourceB.id });

    receipt.stage = "linked-comparison";
    await page.getByLabel("Pinned Source B", { exact: true }).selectOption(sourceA.id);
    const linkedViewers = page.locator(".research-ab-pane").getByLabel(`Image viewer: ${sourceA.name}`, { exact: true });
    const linkedA = linkedViewers.nth(0);
    const linkedB = linkedViewers.nth(1);
    await ready(linkedA);
    await ready(linkedB);
    const link = page.getByRole("checkbox", { name: "Link pan and zoom", exact: true });
    await link.check();
    await button(linkedA, "1:1").press("Enter");
    for (let step = 0; step < 5; step++) await button(linkedA, "Zoom in").press("Enter");
    await page.waitForFunction(() => {
      const panes = [...document.querySelectorAll(".research-ab-pane .image-viewport")];
      return panes.length === 2 && panes[0].dataset.camera === panes[1].dataset.camera &&
        JSON.parse(panes[0].dataset.camera).scale * devicePixelRatio > 2.5;
    });
    await ready(linkedA);
    await ready(linkedB);
    const linkedSmoothA = await raster(linkedA);
    const linkedNearestB = await raster(linkedB);
    assert.equal(linkedSmoothA.effective, "smooth");
    assert.equal(linkedNearestB.effective, "nearest");
    assert.deepEqual(linkedSmoothA.camera, linkedNearestB.camera);
    await chooseMode(linkedA, "Nearest pixel", "nearest", true);
    await twoFrames();
    const linkedNearestA = await raster(linkedA);
    const linkedStableB = await raster(linkedB);
    assert.deepEqual(binding(linkedSmoothA), binding(linkedNearestA));
    assert.notDeepEqual(rasterValues(linkedSmoothA), rasterValues(linkedNearestA),
      "Pane A keyboard selection must change the painted seam");
    assert.deepEqual(binding(linkedNearestB), binding(linkedStableB));
    assert.deepEqual(rasterValues(linkedNearestB), rasterValues(linkedStableB),
      "Pane A sampling changed the linked pane's source pixels");
    assert.equal(await linkedB.getAttribute("data-display-sampling"), "nearest");
    assert.ok(await link.isChecked());
    receipt.checks.push({ name: "linked-comparison-pixels-and-camera",
      before: { pane_a: linkedSmoothA, pane_b: linkedNearestB },
      after: { pane_a: linkedNearestA, pane_b: linkedStableB } });
    await screenshot("linked-comparison-modes");

    const rounds = [
      { pane: linkedB, name: "B", control: "1:1", count: 1, zoom: 1 },
      { pane: linkedB, name: "B", control: "Zoom in", count: 3, zoom: 1.25 ** 3 },
      { pane: linkedA, name: "A", control: "Zoom out", count: 2, zoom: 1.25 },
      { pane: linkedB, name: "B", control: "Zoom in", count: 1, zoom: 1.25 ** 2 },
    ];
    const observed = [];
    for (const { pane, name, control, count, zoom } of rounds) {
      for (let step = 0; step < count; step++) await button(pane, control).press("Enter");
      await page.waitForFunction(expected => {
        const cameras = [...document.querySelectorAll(".research-ab-pane .image-viewport")]
          .map(view => JSON.parse(view.dataset.camera));
        return cameras.length === 2 && cameras.every(camera =>
          Math.abs(camera.scale * devicePixelRatio - expected) < 1e-6 &&
          camera.x === cameras[0].x && camera.y === cameras[0].y);
      }, zoom);
      await twoFrames();
      const a = JSON.parse(await linkedA.getAttribute("data-camera"));
      const b = JSON.parse(await linkedB.getAttribute("data-camera"));
      assert.deepEqual(a, b);
      assert.ok(Math.abs(a.scale * linkedSmoothA.dpr - zoom) < 1e-6);
      observed.push({ initiating_pane: name, control, count, expected_native_zoom: zoom, camera: a });
    }
    receipt.checks.push({ name: "linked-navigation-from-either-pane", rounds: observed });

    await button(page, "Exit A/B").click();
    await page.locator(".research-ab-comparison").waitFor({ state: "hidden" });
    await ready(main);
    assert.equal(await main.getAttribute("data-display-sampling"), "smooth");

    receipt.stage = "processing-preview";
    await selectWorkbenchTool(page, "Process");
    await button(page, "Whole image").click();
    await button(page, "Gaussian blur").click();
    await button(main, "1:1").click();
    await button(main, "Zoom out").click();
    await chooseMode(main, "Nearest pixel", "nearest");
    await button(page, "Preview selected crop").click();
    await readout(main).getByText("Source · nearest pixel", { exact: true }).waitFor({ state: "visible" });
    await readout(main).getByText("Preview · smoothed", { exact: true }).waitFor({ state: "visible" });
    const reducedPreview = await readout(main).allTextContents();
    await screenshot("reduced-processing-preview");
    await button(main, "1:1").click();
    await chooseMode(main, "Smooth", "smooth");
    assert.equal(await main.getByLabel("Native pixel zoom").textContent(), "100%");
    await readout(main).getByText("Source · smoothed", { exact: true }).waitFor({ state: "visible" });
    await readout(main).getByText("Preview · nearest pixel", { exact: true }).waitFor({ state: "visible" });
    receipt.checks.push({ name: "independent-source-and-preview-readouts",
      reduced: reducedPreview, native: await readout(main).allTextContents() });
    await screenshot("native-processing-preview");
  }

  receipt.stage = "integrity";
  assert.deepEqual(await Promise.all(fixtures.map(sha256)), receipt.fixture.sources, "Source bytes changed");
  assert.deepEqual(await artifactHashes(), receipt.build.artifacts, "Packaged bytes changed");
  assert.deepEqual(receipt.renderer_errors, []);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error.stack ?? String(error);
  if (page) await screenshot("failure").catch(() => {});
  throw error;
} finally {
  if (app) {
    try {
      await Promise.all([
        app.waitForEvent("close", { timeout: 30_000 }),
        app.evaluate(({ app: runtime }) => { setTimeout(() => runtime.quit(), 0); }),
      ]);
      receipt.app_shutdown = "ordinary quit";
    } catch (error) {
      receipt.status = "failed";
      receipt.shutdown_error = error.message;
      await app.close().catch(() => {});
      process.exitCode = 1;
    }
  }
  receipt.completed_at = new Date().toISOString();
  await save();
  console.log(`Display sampling ${receipt.status}. Receipt: ${path.join(output, "receipt.json")}`);
}
