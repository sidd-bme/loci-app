import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { captureMprRaster, captureVolume, inspectBundle, sha256, sourcePosition } from "./volume-entry.qa.mjs";
import { fileMenuAction, setVolumeDetailsOpen, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const usage = `From the repository root (requires installed desktop dependencies):
  LOCI_PACKAGED_APP="$APP" LOCI_QA_SOURCE_COMMIT="$PACKAGED_COMMIT" \\
  LOCI_QA_BIO_IMAGE="$KIDNEY_OME_TIF" LOCI_QA_OUTPUT_ROOT="$EVIDENCE" \\
  LOCI_QA_SECONDARY_DISPLAY="$SIDECAR_NAME" node desktop/tests/volume-picker-navigation.qa.mjs
Add --preflight to verify inputs and bundle identity without touching the display or launching Electron.`;
const help = `${usage}\nAdd --baseline-geometry to capture four-pane and single-view geometry on an older app.`;

const KIDNEY_SHA = "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564";
// Pinned TIFF's OME Pixels metadata in native XYZ order. The image-frame origin is zero.
const DIMENSIONS = [512, 512, 16];
const SPACING = [1.24, 1.24, 1.25];
const REFINED_OVERVIEW = 256;
const WINDOW = { width: 1120, height: 760 };
const FILE_PICKER = "Add microscopy or medical images";
const FOLDER_PICKER = "Select a folder of research images";
const TIMEOUT = 120_000;
const PANES = ["axial", "coronal", "sagittal", "volume"];
const PRESETS = {
  XY: { back: [0, 0, -1], up: [0, -1, 0] },
  XZ: { back: [0, -1, 0], up: [0, 0, 1] },
  YZ: { back: [1, 0, 0], up: [0, 0, 1] },
};
const cameraName = plane => `View along source ${plane}`;
const cameraNames = [...Object.keys(PRESETS).map(cameraName), "Reset camera"];
const detailsSelector = "details.raw-volume-rendering-detail";
const require = createRequire(import.meta.url);

function absoluteSetting(name) {
  const value = process.env[name];
  assert.ok(path.isAbsolute(value ?? ""), `Set ${name} to an absolute path.\n${usage}`);
  return value;
}

async function preflight() {
  assert.equal(process.platform, "darwin", "This journey targets the signed macOS package on Sidecar.");
  const bundle = await fs.realpath(absoluteSetting("LOCI_PACKAGED_APP"));
  const fixture = await fs.realpath(absoluteSetting("LOCI_QA_BIO_IMAGE"));
  const outputRoot = absoluteSetting("LOCI_QA_OUTPUT_ROOT");
  const commit = process.env.LOCI_QA_SOURCE_COMMIT;
  assert.match(commit ?? "", /^[a-f0-9]{40}$/u, "Set LOCI_QA_SOURCE_COMMIT to the full packaged revision.");
  assert.equal(path.extname(bundle), ".app");
  const [build, fixtureHash] = await Promise.all([inspectBundle(bundle), sha256(fixture)]);
  assert.equal(fixtureHash, KIDNEY_SHA, "Use the pinned public Kidney - 16 optical sections.ome.tif.");
  assert.equal(build.identity.sourceRevision, commit, "The requested revision does not match the packaged identity.");
  await fs.access(build.executable, constants.X_OK);
  return { build, fixture: { path: fixture, sha256: fixtureHash, dimensions_xyz: DIMENSIONS, spacing_xyz_um: SPACING }, outputRoot };
}

async function waitFor(read, accept, label, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const vectorDelta = (a, b) => a.map((value, axis) => value - b[axis]);
const distance = camera => Math.hypot(...vectorDelta(camera.position_xyz, camera.focal_point_xyz));
const cameraZoom = camera => camera.projection === "parallel" ? camera.parallel_scale : distance(camera);
const samePoint = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  Math.hypot(...vectorDelta(a, b)) <= 1e-6;
const sameZoom = (a, b) => a.projection === b.projection &&
  Math.abs(a.view_angle_degrees - b.view_angle_degrees) <= 1e-6 && Math.abs(cameraZoom(a) - cameraZoom(b)) <= 1e-6;
const samePose = (a, b) => samePoint(a.position_xyz, b.position_xyz) && samePoint(a.focal_point_xyz, b.focal_point_xyz) &&
  samePoint(a.view_up_xyz, b.view_up_xyz) && sameZoom(a, b);

function assertPreset(camera, expected, reference, plane) {
  assert.ok(samePoint(camera.focal_point_xyz, reference.focal_point_xyz), `${plane} moved the focal point`);
  assert.ok(sameZoom(camera, reference), `${plane} changed projection or zoom`);
  if (reference.projection === "parallel")
    assert.ok(Math.abs(distance(camera) - distance(reference)) <= 1e-6, `${plane} changed camera distance`);
  const back = vectorDelta(camera.position_xyz, camera.focal_point_xyz).map(value => value / distance(camera));
  assert.ok(samePoint(back, expected.back), `${plane} camera-back vector: ${back}`);
  assert.ok(samePoint(camera.view_up_xyz, expected.up), `${plane} view-up vector: ${camera.view_up_xyz}`);
}

async function measureLayout(raw, order, redesigned) {
  const result = await raw.evaluate((root, ids) => {
    const rect = node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const grid = root.querySelector(".raw-volume-panes");
    const rows = ids.map(id => {
      const pane = id === "volume" ? root.querySelector(".mpr-pane-volume") : root.querySelector(`[data-pane="${id}"]`);
      const stage = pane.querySelector(".raw-volume-stage, .mpr-slice-stage");
      return { id, pane: rect(pane), stage: rect(stage), canvas: rect(stage.querySelector("canvas")) };
    });
    return { root: rect(root), grid: rect(grid), viewport: [innerWidth, innerHeight], rows };
  }, order);
  const { root, grid, rows } = result;
  assert.deepEqual(result.viewport, [WINDOW.width, WINDOW.height], "The content viewport changed during QA.");
  const intersectionArea = box => {
    const width = Math.min(box.x + box.width, root.x + root.width, WINDOW.width) - Math.max(box.x, root.x, 0);
    const height = Math.min(box.y + box.height, root.y + root.height, WINDOW.height) - Math.max(box.y, root.y, 0);
    return Math.max(0, width) * Math.max(0, height);
  };
  result.visible_css_px2 = {
    grid: intersectionArea(grid),
    stages: Object.fromEntries(rows.map(({ id, stage }) => [id, intersectionArea(stage)])),
    canvases: Object.fromEntries(rows.map(({ id, canvas }) => [id, intersectionArea(canvas)])),
  };
  result.pre_grid_css_px = grid.y - root.y;
  if (!redesigned) return result;
  assert.ok(grid.y >= root.y - 1 && grid.y - root.y <= 76,
    "The image grid must begin within the first 76 CSS px of the volume viewport.");
  assert.ok(grid.y + grid.height <= Math.min(root.y + root.height, WINDOW.height) + 1,
    "Parts of the grid are outside the visible viewport.");
  assert.ok(grid.height >= 0.65 * root.height, "The image grid occupies less than 65% of the volume viewport height.");
  const stageArea = rows.reduce((area, { stage }) => area + stage.width * stage.height, 0);
  assert.ok(stageArea >= 0.67 * grid.width * grid.height, "Pane chrome takes more than one third of the grid area.");
  for (const { id, stage, canvas } of rows) {
    assert.ok(stage.height >= 120 && stage.width >= 130, `${id} image stage is too small`);
    assert.ok(canvas.width > 0 && canvas.height > 0 && canvas.height <= stage.height + 1 &&
      canvas.width <= stage.width + 1, `${id} rendered canvas does not fit its image stage`);
  }
  if (rows.length === 4) {
    const [a, c, s, v] = rows.map(row => row.pane);
    assert.ok(a.x < c.x && a.y < s.y && Math.abs(a.x - s.x) <= 1 && Math.abs(c.x - v.x) <= 1 &&
      Math.abs(a.y - c.y) <= 1 && Math.abs(s.y - v.y) <= 1 &&
      c.x >= a.x + a.width - 1 && s.y >= a.y + a.height - 1, "Expected the default non-overlapping 2×2 layout.");
    assert.ok(rows.every(({ pane }) => Math.abs(pane.width - a.width) <= 2 && Math.abs(pane.height - a.height) <= 2),
      "The four default quadrants must be equally sized.");
    const { stage, canvas } = rows[0];
    assert.ok(canvas.height >= 0.85 * Math.min(stage.height, stage.width),
      "The square axial image uses too little of its available stage.");
  }
  return result;
}

async function run(config, baseline) {
  assert.ok(process.env.LOCI_QA_SECONDARY_DISPLAY, "Set LOCI_QA_SECONDARY_DISPLAY to the connected Sidecar display name.");
  await fs.mkdir(config.outputRoot, { recursive: true });
  const output = await fs.mkdtemp(path.join(config.outputRoot, "volume-picker-navigation-"));
  const profile = path.join(output, "profile");
  const loader = new URL("../../scripts/qa/secondary-display-loader.mjs", import.meta.url);
  const report = {
    schema: "loci.qa.volume-picker-navigation/v1", status: "running", started_at: new Date().toISOString(),
    mode: baseline ? "baseline-geometry" : "redesigned-volume-and-picker",
    build: config.build, fixture: config.fixture, harness_sha256: await sha256(new URL(import.meta.url)),
    display_loader_sha256: await sha256(loader), launches: [], screenshots: {}, page_errors: [],
    evidence_scope: [
      "Actual packaged import and renderer. Mock chooser returns selection or cancellation after recording the exact Electron dialog options.",
      "Playwright pointer, wheel, Ctrl+wheel and keyboard input through Chromium. Physical mouse and Sidecar trackpad gestures require manual verification.",
      "Kidney fixture has axis-aligned XYZ geometry. The receipt qualifies source-axis camera snaps on this fixture.",
    ],
  };

  let app, page, source, failure, phase = "Sidecar placement and initial launch";
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const scene = () => page.evaluate(source_id => window.lociResearch.execute("volume_view", { source_id }), source.id);
  const nextScene = (previous, predicate, label) =>
    waitFor(scene, value => value?.revision > previous.revision && value.state?.camera && predicate(value.state), label);
  const dialogCalls = () => app.evaluate(() => globalThis.__lociVolumePickerQaCalls ?? []);
  async function shot(name) {
    const file = `${name}.png`;
    const png = path.join(output, file);
    await page.screenshot({ path: png, animations: "disabled", timeout: 10_000 });
    report.screenshots[name] = { file, sha256: await sha256(png) };
  }
  async function launch(answers) {
    // Use the same Playwright instance wrapped by the Sidecar loader.
    const { _electron } = require("playwright");
    const environment = { ...process.env, LOCI_MODEL_HOME: path.join(profile, "models") };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.PYTHONPATH;
    app = await _electron.launch({
      executablePath: config.build.executable, args: [`--user-data-dir=${profile}`], timeout: TIMEOUT,
      env: environment,
    });
    const entry = { pid: app.process().pid, dialogs: [] };
    report.launches.push(entry);
    page = await app.firstWindow({ timeout: TIMEOUT });
    page.on("pageerror", error => report.page_errors.push(error.stack ?? error.message));
    const display = await app.evaluate(({ BrowserWindow, screen, app: native }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const target = screen.getDisplayMatching(win.getBounds());
      return { id: target.id, label: target.label, primary: target.id === screen.getPrimaryDisplay().id,
        work_area: target.workArea, initial_bounds: win.getBounds(), user_data: native.getPath("userData") };
    });
    entry.display = display;
    assert.equal(display.primary, false, "The QA window is on the primary display.");
    assert.equal(await fs.realpath(display.user_data), await fs.realpath(profile), "The launched app is not isolated.");
    const placement = await app.evaluate(({ BrowserWindow, screen }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(size.width, size.height);
      return { bounds: win.getBounds(), content_size: win.getContentSize(),
        display_id: screen.getDisplayMatching(win.getBounds()).id };
    }, WINDOW);
    entry.placement = placement;
    const { work_area: area } = display;
    const b = placement.bounds;
    assert.equal(placement.display_id, display.id);
    assert.deepEqual(placement.content_size, [WINDOW.width, WINDOW.height]);
    assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width &&
      b.y + b.height <= area.y + area.height, "The fixed window does not fit on the selected Sidecar work area.");
    await app.evaluate(({ dialog }, queue) => {
      const calls = [];
      globalThis.__lociVolumePickerQaCalls = calls;
      dialog.showOpenDialog = async (...args) => {
        const { title, defaultPath, properties } = args.at(-1);
        const expected = queue[calls.length];
        calls.push({ title, defaultPath: defaultPath ?? null, properties, mocked: true, canceled: !expected?.file });
        if (expected?.title !== title) throw new Error(`Unexpected open dialog: ${title}`);
        return expected.file ? { canceled: false, filePaths: [expected.file] } : { canceled: true, filePaths: [] };
      };
    }, answers);
  }
  async function readDialogs(count) {
    const calls = await waitFor(dialogCalls, value => value.length >= count, `${count} image picker calls`);
    report.launches.at(-1).dialogs = calls;
    assert.equal(calls.length, count, "Unexpected additional native dialog calls.");
    return calls;
  }
  async function close() {
    if (!app) return;
    const current = app;
    const entry = report.launches.at(-1);
    const calls = await dialogCalls().catch(() => null);
    if (calls) entry.dialogs = calls;
    app = null;
    page = null;
    await current.close();
  }

  async function journey() {
    await import(loader.href);
    const directory = path.dirname(config.fixture.path);
    const firstSelection = { title: FILE_PICKER, file: config.fixture.path };
    await launch(baseline ? [firstSelection] : [firstSelection, { title: FILE_PICKER }, { title: FOLDER_PICKER }]);
    phase = "normal Open images";
    await button(page, "Open images").click({ timeout: TIMEOUT });
    const imported = await waitForSnapshot(page, value => value?.sources?.some(item => item.sha256 === KIDNEY_SHA),
      "the pinned kidney import", TIMEOUT);
    assert.equal(imported.sources.length, 1);
    [source] = imported.sources;
    const raw = page.getByRole("region", { name: "Raw whole-volume viewport", exact: true });
    async function openVolume() {
      await button(page, "3D volume").click({ timeout: TIMEOUT });
      await raw.waitFor({ timeout: TIMEOUT });
      report.context_dimensions_xyz = await waitFor(async () => {
        const value = await raw.getAttribute("data-context-dimensions");
        return value?.split("x").map(Number);
      }, dimensions => dimensions && Math.max(...dimensions) === REFINED_OVERVIEW, "the refined overview payload", TIMEOUT);
      const initial = await waitFor(scene, value => value?.state?.camera &&
        value.state.refinement.target_long_axis === REFINED_OVERVIEW, "the persisted, progressively refined scene", TIMEOUT);
      assert.equal(await raw.getAttribute("data-source-sha256"), KIDNEY_SHA);
      assert.equal(initial.state.layout.mode, "four");
      assert.equal(initial.state.layout.expanded_pane, null);
      assert.deepEqual(initial.state.layout.pane_order, PANES);
      return initial;
    }
    if (baseline) {
      phase = "baseline four-pane and single-view geometry";
      await readDialogs(1);
      const initial = await openVolume();
      report.four = await measureLayout(raw, PANES, false);
      await shot("01-default-four-panes");
      await button(raw, "3D view").click();
      await nextScene(initial, state => state.layout.mode === "single", "the saved single-pane layout");
      report.single = await measureLayout(raw, ["volume"], false);
      await shot("02-single-view");
      assert.deepEqual(report.page_errors, []);
      report.status = "passed";
      return;
    }
    phase = "remembered directory and cancellation";
    const add = button(page, "Add images…");
    await add.click();
    const [first, repeat] = await readDialogs(2);
    assert.notEqual(first.defaultPath, directory, "The fresh profile already starts in the fixture directory.");
    assert.equal(first.canceled, false);
    assert.ok(first.properties.includes("openFile"));
    assert.equal(repeat.defaultPath, directory, "Repeat Add images did not start in the imported file's parent.");
    assert.equal(repeat.canceled, true);

    await fileMenuAction(page, "Open folder");
    const folder = (await readDialogs(3)).at(-1);
    assert.equal(folder.defaultPath, directory, "Canceling Add images erased the shared image location.");
    assert.ok(folder.canceled && folder.properties.includes("openDirectory"));
    const stillOpen = await waitForSnapshot(page, value => value?.sources?.length === 1, "the existing study after cancellation");
    assert.equal(stillOpen.sources[0].id, source.id);

    phase = "default four-pane layout and source coordinates";
    const viewport3D = raw.getByRole("region", { name: "3D view", exact: true });
    const canvas3D = viewport3D.getByLabel("Interactive three-dimensional volume", { exact: true }).locator("canvas");
    const slices = PANES.slice(0, 3).map(id => raw.locator(`[data-pane="${id}"] canvas`));
    const advanced = raw.locator(detailsSelector);
    const initial = await openVolume();
    assert.equal(await advanced.evaluate(node => node.open), false);
    assert.equal(await raw.getByRole("region", { name: "Volume labels and selection", exact: true }).count(), 0);
    for (const name of cameraNames) {
      assert.equal(await button(raw, name).count(), 1, `Expected exactly one ${name} control`);
      await button(viewport3D, name).waitFor();
    }
    report.four = await measureLayout(raw, PANES, true);
    await shot("01-default-four-panes");

    const axialBefore = await captureMprRaster(slices[0]);
    await setVolumeDetailsOpen(raw);
    const native = await sourcePosition(page, DIMENSIONS);
    assert.deepEqual(native, initial.state.crosshair_source_xyz);
    const zKey = native[2] + 1 < DIMENSIONS[2] ? "ArrowRight" : "ArrowLeft";
    const expected = [native[0], native[1], native[2] + (zKey === "ArrowRight" ? 1 : -1)];
    await raw.getByRole("slider", { name: "Z slice", exact: true }).press(zKey);
    const stepped = await nextScene(initial, state => state.crosshair_source_xyz[2] === expected[2], "one native Z step");
    assert.deepEqual(await sourcePosition(page, DIMENSIONS), expected);
    assert.deepEqual(stepped.state.crosshair_source_xyz, expected);
    const world = expected.map((value, axis) => value * SPACING[axis]);
    const rasters = await Promise.all(slices.map(captureMprRaster));
    for (const [index, raster] of rasters.entries()) {
      assert.equal(raster.render_binding[1], PANES[index]);
      assert.ok(samePoint(raster.render_binding[2], world), `${PANES[index]} disagrees with calibrated crosshair XYZ`);
    }
    assert.notEqual(rasters[0].rgba_sha256, axialBefore.rgba_sha256, "The axial canvas did not repaint after the native Z step.");
    await setVolumeDetailsOpen(raw, false);
    report.crosshair = { before_xyz: native, after_xyz: expected, world_xyz_um: world, axial_before: axialBefore, panes: rasters };

    phase = "axis presets and camera reset in four panes";
    await page.mouse.move(2, 2);
    const initialImage = await captureVolume(app, page, output, "camera-initial", canvas3D);
    assert.ok(initialImage.distinct_maximum_intensities > 10 && initialImage.central_signal_fraction > 0.002,
      "The initial 3D canvas lacks specimen signal.");
    report.camera = { initial: { pose: stepped.state.camera, image: initialImage }, presets: {} };
    let previous = stepped;
    const pixelHashes = new Set([initialImage.sampled_pixel_sha256]);
    for (const [plane, preset] of Object.entries(PRESETS)) {
      const name = cameraName(plane);
      await button(viewport3D, name).click();
      await page.mouse.move(2, 2);
      const snapped = await nextScene(previous, state => !samePose(state.camera, previous.state.camera), name);
      assertPreset(snapped.state.camera, preset, stepped.state.camera, plane);
      assert.deepEqual(snapped.state.crosshair_source_xyz, expected);
      const image = await captureVolume(app, page, output, `camera-${plane.toLowerCase()}`, canvas3D);
      assert.ok(image.distinct_maximum_intensities > 4, `${plane} did not render visible specimen tones.`);
      assert.ok(!pixelHashes.has(image.sampled_pixel_sha256), `${plane} reused previous visible 3D pixels.`);
      pixelHashes.add(image.sampled_pixel_sha256);
      report.camera.presets[plane] = { pose: snapped.state.camera, saved_revision: snapped.revision, image };
      previous = snapped;
    }
    await shot("02-four-panes-yz-camera");
    const reset = button(viewport3D, "Reset camera");
    await reset.click();
    await page.mouse.move(2, 2);
    const restored = await nextScene(previous, state => samePose(state.camera, stepped.state.camera), "reset to initial camera");
    assert.deepEqual(restored.state.crosshair_source_xyz, expected);
    assert.deepEqual(await Promise.all(slices.map(captureMprRaster)), rasters, "Camera controls changed linked slice rasters.");
    const resetImage = await captureVolume(app, page, output, "camera-reset", canvas3D);
    assert.equal(resetImage.sampled_pixel_sha256, initialImage.sampled_pixel_sha256, "Reset did not restore the visible 3D raster.");
    report.camera.reset = { pose: restored.state.camera, image: resetImage };

    phase = "single 3D layout and automated input";
    await button(raw, "3D view").click();
    const single = await nextScene(restored, state => state.layout.mode === "single", "the saved single-pane layout");
    assert.equal(await raw.locator("[data-pane] canvas:visible").count(), 0, "Slice canvases remain visible in single view.");
    report.single = await measureLayout(raw, ["volume"], true);
    assert.ok(report.single.rows[0].stage.height > report.four.rows[3].stage.height * 1.5,
      "The single view did not materially expand the 3D stage.");
    const singleImage = await captureVolume(app, page, output, "single-initial", canvas3D);
    const box = await canvas3D.boundingBox();
    assert.ok(box, "The single-view 3D canvas is not a pointer target.");
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 55, y + 28, { steps: 8 });
    await page.mouse.up();
    const orbit = await nextScene(single, state => !samePose(state.camera, single.state.camera), "primary mouse drag orbit");
    assert.ok(samePoint(orbit.state.camera.focal_point_xyz, single.state.camera.focal_point_xyz), "Orbit changed focal point.");
    assert.ok(sameZoom(orbit.state.camera, single.state.camera), "Orbit changed zoom.");
    const orbitImage = await captureVolume(app, page, output, "single-orbit", canvas3D);
    assert.notEqual(orbitImage.sampled_pixel_sha256, singleImage.sampled_pixel_sha256, "Orbit did not change visible pixels.");
    // Observe input before the 3D stage consumes it. One unsaturated pixel delta
    // should produce one camera update in each wheel path.
    await canvas3D.evaluate(canvas => {
      window.__lociQaWheelEvents = [];
      window.addEventListener("wheel", event => {
        if (event.target === canvas) window.__lociQaWheelEvents.push({ deltaY: event.deltaY,
          mode: event.deltaMode, control: event.ctrlKey, trusted: event.isTrusted });
      }, { capture: true, passive: true });
    });
    const deltaY = -40;
    await page.mouse.wheel(0, deltaY);
    const wheel = await nextScene(orbit, state => !sameZoom(state.camera, orbit.state.camera), "ordinary wheel zoom");
    await page.keyboard.down("Control");
    try { await page.mouse.wheel(0, deltaY); } finally { await page.keyboard.up("Control"); }
    const pinch = await nextScene(wheel, state => !sameZoom(state.camera, wheel.state.camera), "Ctrl+wheel zoom");
    const events = await page.evaluate(() => window.__lociQaWheelEvents);
    assert.deepEqual(events, [false, true].map(control => ({ deltaY, mode: 0, control, trusted: true })));
    const zoomRatios = [];
    for (const [changed, base, sensitivity] of [[wheel, orbit, 0.0025], [pinch, wheel, 0.01]]) {
      assert.ok(samePoint(changed.state.camera.focal_point_xyz, base.state.camera.focal_point_xyz));
      const ratio = cameraZoom(changed.state.camera) / cameraZoom(base.state.camera);
      const expectedRatio = Math.exp(deltaY * sensitivity);
      assert.ok(Math.abs(ratio - expectedRatio) <= 1e-6, `A single wheel event gave zoom ratio ${ratio}; expected ${expectedRatio}.`);
      assert.deepEqual(changed.state.crosshair_source_xyz, expected);
      zoomRatios.push({ ratio, expected: expectedRatio });
    }
    report.camera.inputs = { orbit: orbit.state.camera, orbit_image: orbitImage, wheel: wheel.state.camera,
      ctrl_wheel: pinch.state.camera, wheel_events: events, wheel_zoom_ratios: zoomRatios };
    await shot("03-single-after-input");

    phase = "cold same-profile launch";
    await readDialogs(3);
    await close();
    await launch([{ title: FILE_PICKER }]);
    const open = button(page, "Open images").or(button(page, "Add images…")).filter({ visible: true });
    await open.click({ timeout: TIMEOUT });
    const [cold] = await readDialogs(1);
    assert.equal(cold.defaultPath, directory, "The remembered image directory did not survive app shutdown.");
    assert.equal(cold.canceled, true);
    assert.notEqual(report.launches[0].pid, report.launches[1].pid, "The cold launch must have a new process.");
    assert.equal(await sha256(config.fixture.path), KIDNEY_SHA, "The original kidney fixture changed.");
    assert.deepEqual(report.page_errors, []);
    report.status = "passed";
  }
  try {
    await journey();
  } catch (error) {
    failure = error;
    report.failure = { phase, stack: error.stack ?? String(error) };
    if (page) await shot("failure").catch(() => {});
  } finally {
    try { await close(); } catch (error) {
      report.close_error = error.stack ?? String(error);
      failure ??= error;
    }
    if (failure) report.status = "failed";
    report.finished_at = new Date().toISOString();
    const receipt = path.join(output, "receipt.json");
    await fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ status: report.status, receipt }));
  }
  if (failure) throw failure;
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(help);
} else {
  assert.ok(args.length === 0 || (args.length === 1 && ["--preflight", "--baseline-geometry"].includes(args[0])), help);
  const config = await preflight();
  if (args.includes("--preflight")) console.log(JSON.stringify(config, null, 2));
  else await run(config, args.includes("--baseline-geometry"));
}
