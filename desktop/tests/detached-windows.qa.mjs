import assert from "node:assert/strict";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import { startProcessTreeRssSampler } from "./navigation-performance-qa-helpers.mjs";

const run = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(desktop, "..");
const bundle = process.env.LOCI_PACKAGED_APP;
if (!bundle || process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Set LOCI_PACKAGED_APP to the exact macOS arm64 candidate.");
const root = path.join(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repository, ".loci/evidence/qa/detached"),
  new Date().toISOString().replaceAll(/[:.]/g, "-"));
await fs.mkdir(root, { recursive: true });
const executable = path.join(bundle, "Contents/MacOS/Loci");
const worker = path.join(bundle, "Contents/Resources/loci-engine/loci-engine");
async function hash(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
const identity = { executable: await hash(executable), asar: await hash(path.join(bundle, "Contents/Resources/app.asar")), worker: await hash(worker) };
const git = async (...args) => (await run("git", args, { cwd: repository })).stdout.trim();
const source = { head: await git("rev-parse", "HEAD"), desktopTree: await git("rev-parse", "HEAD:desktop"), status: await git("status", "--porcelain"), harness: await hash(import.meta.filename) };
const fixtures = ["synthetic-volume-a.ome.tif", "synthetic-plane-b.ome.tif", "synthetic-rgb.tif", "synthetic-medical.nii"].map((name) => path.join(root, name));
const study = path.join(root, "detached-journey.loci-study");
const figure = path.join(root, "detached-volume.loci-figure");
const generator = path.join(root, "generate.py");
await fs.writeFile(generator, `import numpy as np\nimport tifffile\nfrom pathlib import Path\np = ${JSON.stringify(fixtures)}\nfor index, dest in enumerate(p[:2]):\n z,y,x=np.ogrid[:(12 if index==0 else 1),:128,:160]\n a=np.broadcast_to(((x-55)**2+(y-55)**2<25**2)*45000,(len(z),128,160)).copy()\n b=np.broadcast_to(((x-110)**2+(y-80)**2<18**2)*55000,(len(z),128,160)).copy()\n data=np.stack([a,b]).astype(np.uint16)\n tifffile.imwrite(dest,data,ome=True,photometric='minisblack',metadata={'axes':'CZYX','PhysicalSizeX':0.5,'PhysicalSizeXUnit':'µm','PhysicalSizeY':0.75,'PhysicalSizeYUnit':'µm','PhysicalSizeZ':2.5,'PhysicalSizeZUnit':'µm','Channel':{'Name':['Synthetic A','Synthetic B']}})\ncolour=np.zeros((4096,4096,3),dtype=np.uint8)\ncolour[:]=[128,64,32]\ntifffile.imwrite(p[2],colour,photometric='rgb')\nimport SimpleITK as sitk\nz,y,x=np.ogrid[:12,:128,:160]\nscan=np.broadcast_to(((x-80)**2+(y-64)**2<35**2)*200-100,(12,128,160)).astype(np.int16).copy()\nimage=sitk.GetImageFromArray(scan)\nimage.SetSpacing((0.7,0.8,2.5))\nimage.SetOrigin((10.0,20.0,30.0))\nsitk.WriteImage(image,p[3])\n`);
await run(path.join(repository, "engine/.venv/bin/python"), [generator]);
const fixtureHashes = await Promise.all(fixtures.map(hash));
const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(root, "user-data")}`], cwd: desktop, timeout: 120000 });
const errors = [];
const watch = (page) => page.on("pageerror", (error) => errors.push(error.message));
app.on("window", watch);
const main = await app.firstWindow(); watch(main);
const sampler = await startProcessTreeRssSampler(app.process().pid, { intervalMs: 200, workerCommandIncludes: worker });
const passed = [];
const screenshots = [];
async function capture(page, name) { const file = path.join(root, `${name}.png`); await page.screenshot({ path: file }); screenshots.push({ name, sha256: await hash(file) }); }
async function until(check, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await main.waitForTimeout(80); } throw new Error(`Timed out: ${label}`); }
async function state(page = main) { return page.evaluate(() => window.lociImageWindows.state()); }
async function imagePage(viewId) {
  let found;
  await until(async () => {
    for (const page of app.windows()) {
      if (page === main || page.isClosed()) continue;
      const target = await page.evaluate(() => window.lociImageWindows?.state()).catch(() => null);
      if (target?.target?.viewId === viewId) { found = page; return true; }
    }
    return false;
  }, `image window ${viewId}`);
  return found;
}
async function focusNative(page) { const window = await app.browserWindow(page); await window.evaluate((window) => { window.show(); window.focus(); }); }
async function readyImage(page) {
  await page.locator('.image-viewport[data-prepared="true"]').waitFor({ timeout: 60000 });
}
async function controller(label) { const node = main.getByRole("region", { name: `Controls for ${label}`, exact: true }); await node.waitFor({ state: "visible" }); return node; }
let report;
try {
  await app.evaluate(({ dialog, BrowserWindow }, { fixtures, study, figure }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 10, y: 40, width: 1200, height: 800 });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      return { canceled: false, filePaths: title === "Open research study" ? [study] : fixtures };
    };
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: args.at(-1)?.title === "Export volume figure" ? figure : study });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { fixtures, study, figure });
  await main.getByRole("button", { name: "Open images", exact: true }).click();
  await main.getByRole("button", { name: "Detach image", exact: true }).waitFor({ timeout: 60000 });
  const snapshot = await main.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(snapshot.sources.length, fixtures.length);
  const [a, b, rgb, medical] = fixtures.map((file) => snapshot.sources.find((entry) => entry.name === path.basename(file)));
  assert.ok(a && b && rgb && medical); assert.equal(a.sha256, fixtureHashes[0]); assert.equal(b.sha256, fixtureHashes[1]);
  // Save first so local layout has the same document identity during reopen.
  await main.getByRole("button", { name: "Save study", exact: true }).click();
  await main.evaluate(() => window.lociResearch.getSnapshot());
  await main.locator(".research-sources").getByRole("button", { name: /^synthetic-volume-a\.ome\.tif/ }).click();
  await selectWorkbenchTool(main, "Display");
  await main.locator("details.source-channel").first().locator(":scope > summary").click();
  await main.getByLabel("Channel 1 color", { exact: true }).fill("#a020e0");
  await main.getByLabel("Channel 1 opacity", { exact: true }).fill("0.37");
  // A real resize must leave the image stage outside the inspector, not merely
  // avoid document scrollbars while hiding scientific pixels underneath it.
  await (await app.browserWindow(main)).evaluate(window => window.setBounds({ width: 1024, height: 720 }));
  await main.getByRole("button", { name: "Fit image", exact: true }).click();
  const geometryBeforeDetach = await main.evaluate(() => {
    const image = document.querySelector(".image-viewport").getBoundingClientRect();
    const inspector = document.querySelector(".research-inspector-shell").getBoundingClientRect();
    const tools = document.querySelector(".image-view-tools").getBoundingClientRect();
    return { right: image.right, inspectorLeft: inspector.left, toolsLeft: tools.left, toolsRight: tools.right, imageLeft: image.left };
  });
  assert.ok(geometryBeforeDetach.right <= geometryBeforeDetach.inspectorLeft + 1);
  assert.ok(geometryBeforeDetach.toolsLeft >= geometryBeforeDetach.imageLeft && geometryBeforeDetach.toolsRight <= geometryBeforeDetach.right);
  await main.getByLabel("Channel 1 opacity", { exact: true }).scrollIntoViewIfNeeded();
  await capture(main, "00-configured-compact-workspace");
  await main.getByRole("button", { name: "Detach image", exact: true }).click();
  await main.getByRole("heading", { name: "Image controls", exact: true }).waitFor();
  let views = (await state()).views;
  const first = views[0];
  assert.equal(first.target.sourceId, a.id);
  const pageA = await imagePage(first.target.viewId); await readyImage(pageA);
  const transferred = (await pageA.evaluate(() => window.lociImageWindows.presentation())).presentation;
  assert.equal(transferred.channels[0].color, "#a020e0");
  assert.equal(transferred.channels[0].opacity, 0.37);
  assert.equal(first.initialPresentation.channels[0].opacity, 0.37);
  const colouredPixels = await pageA.locator(".image-viewport > canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4)
      if (pixels[offset] > 15 && pixels[offset] > 2 * pixels[offset + 1] && pixels[offset + 2] > 2 * pixels[offset + 1]) count++;
    return count;
  });
  assert.ok(colouredPixels > 10, "the transferred purple channel must actually render coloured source pixels");
  passed.push("current channel colour/opacity transfer through native window creation; compact stage and toolbar do not overlap inspector");
  await capture(pageA, "01-image-a");
  await capture(main, "02-control-panel");
  passed.push("open calibrated two-channel volume source in an independent image window");

  await main.getByLabel("Open source in a new view", { exact: true }).selectOption(b.id);
  await main.getByRole("button", { name: "Open selected source", exact: true }).click();
  await until(async () => (await state()).views.length === 2, "second image window registered");
  views = (await state()).views;
  const second = views.find((view) => view.target.viewId !== first.target.viewId);
  const pageB = await imagePage(second.target.viewId); await readyImage(pageB);
  await focusNative(pageA);
  await until(async () => (await state()).target?.viewId === first.target.viewId, "focus A");
  await focusNative(main);
  assert.equal((await state()).target.viewId, first.target.viewId);
  await main.getByRole("button", { name: "Pin this target", exact: true }).click();
  await focusNative(pageB);
  assert.equal((await state()).target.viewId, first.target.viewId);
  await main.getByRole("button", { name: "Follow focused view", exact: true }).click();
  assert.equal((await state()).target.viewId, second.target.viewId);
  passed.push("two-source focus follows image windows; control focus retains target; pin/unpin is explicit");

  await focusNative(pageA);
  const controlsA = await controller(first.label);
  await controlsA.getByRole("button", { name: "Rectangle", exact: true }).click();
  await until(async () => (await pageA.evaluate(() => window.lociImageWindows.presentation()))?.presentation.tool === "rectangle", "rectangle tool synchronized");
  // Draw through the real native child canvas using independently chosen source coordinates.
  const geometry = await pageA.locator(".image-viewport").evaluate((node) => ({
    bounds: (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
    camera: JSON.parse(node.getAttribute("data-camera")),
  }));
  const screenPoint = (x, y) => ({ x: geometry.bounds.x + geometry.bounds.width / 2 + (x - geometry.camera.x) * geometry.camera.scale,
    y: geometry.bounds.y + geometry.bounds.height / 2 + (y - geometry.camera.y) * geometry.camera.scale * 1.5 });
  const p1 = screenPoint(10, 10), p2 = screenPoint(30, 30);
  await pageA.mouse.move(p1.x, p1.y); await pageA.mouse.down(); await pageA.mouse.move(p2.x, p2.y, { steps: 8 }); await pageA.mouse.up();
  await until(async () => {
    const draft = (await pageA.evaluate(() => window.lociImageWindows.presentation()))?.presentation.draft;
    return draft?.length === 2 && Math.abs(draft[1].x - 30) < 0.1 && Math.abs(draft[1].y - 30) < 0.1;
  }, "final rectangle geometry received by the main coordinator");
  await controlsA.getByLabel("Annotation label", { exact: true }).fill("Known rectangle A");
  await controlsA.getByRole("button", { name: "Save annotation", exact: true }).click();
  await until(async () => (await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id)).annotations.length === 1, "saved rectangle A");
  const receipt = await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id);
  const polygon = receipt.annotations[0];
  // Pixel pointer rounding is bounded by the current physical viewport scale; validate the actual geometry independently.
  const areaPixels = Math.abs(polygon.points.reduce((total, p, index, pts) => total + p.x * pts[(index + 1) % pts.length].y - pts[(index + 1) % pts.length].x * p.y, 0)) / 2;
  assert.ok(Math.abs(areaPixels - 400) < 15, `Pointer rectangle deviated from 20x20 source pixels: ${areaPixels}`);
  assert.ok(Math.abs(polygon.area - areaPixels * 0.5 * 0.75) < 1e-6);
  assert.equal((await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), b.id)).annotations.length, 0);
  await focusNative(pageB); await focusNative(pageA);
  await (await controller(first.label)).getByRole("button", { name: "Undo annotation", exact: true }).click();
  await until(async () => (await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id)).annotations.length === 0, "source-bound undo");
  await (await controller(first.label)).getByRole("button", { name: "Redo annotation", exact: true }).click();
  await until(async () => (await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id)).annotations.length === 1, "source-bound redo");
  passed.push("native child rectangle gesture, calibrated area, source-bound save/undo/redo across focus");
  await capture(main, "03-measured-annotation");

  const security = await pageA.evaluate(async ({ other }) => {
    const errors = [];
    for (const action of [() => window.lociImageWindows.pin(other), () => window.lociImageWindows.execute(other, "source_annotations", { source_id: other.sourceId }),
      () => window.lociResearch.getSnapshot()]) {
      try { await action(); errors.push(null); } catch (error) { errors.push(String(error)); }
    }
    return errors;
  }, { other: second.target });
  assert.ok(security.every(Boolean));
  passed.push("child IPC cannot pin, target another source or call legacy main-only snapshot");

  // Establish a foreground target explicitly after the control-panel action;
  // retain native state/events so a failed OS transition can be diagnosed.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__fullscreenTrace = [];
    for (const window of BrowserWindow.getAllWindows()) {
      const snapshot = () => ({ id: window.id, title: window.getTitle(), fullscreen: window.isFullScreen(),
        fullscreenable: window.isFullScreenable(), focused: window.isFocused(), visible: window.isVisible(),
        minimized: window.isMinimized(), bounds: window.getBounds() });
      globalThis.__fullscreenTrace.push({ event: "before", ...snapshot() });
      for (const event of ["enter-full-screen", "leave-full-screen", "focus", "blur"])
        window.on(event, () => globalThis.__fullscreenTrace.push({ event, ...snapshot() }));
    }
  });
  await focusNative(pageA);
  const nativeA = await app.browserWindow(pageA);
  await until(async () => nativeA.evaluate(window => window.isFocused()), "native image owns focus before fullscreen");
  await main.evaluate((target) => window.lociImageWindows.fullscreen(target, true), first.target);
  await until(async () => nativeA.evaluate(window => window.isFullScreen() &&
    globalThis.__fullscreenTrace.some(event => event.id === window.id && event.event === "enter-full-screen")),
    "completed native fullscreen entry");
  await pageA.keyboard.press("Escape");
  await until(async () => nativeA.evaluate(window => !window.isFullScreen() &&
    globalThis.__fullscreenTrace.some(event => event.id === window.id && event.event === "leave-full-screen")),
    "completed native fullscreen exit after Escape");
  await until(async () => await main.getByRole("button", { name: "Exit full screen", exact: true }).count() === 0, "control panel reflects native fullscreen exit");
  await nativeA.evaluate((window) => window.setBounds({ x: 30, y: 40, width: 760, height: 540 }));
  await capture(pageA, "04-small-image-window");
  const mainNative = await app.browserWindow(main);
  await mainNative.evaluate((window) => window.setBounds({ width: 1024, height: 720 }));
  await capture(main, "05-small-control-panel");
  assert.equal(await main.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await main.getByRole("button", { name: "Pin this target", exact: true }).focus();
  assert.equal(await main.getByRole("button", { name: "Pin this target", exact: true }).evaluate((node) => node === document.activeElement), true);
  passed.push("native fullscreen/Escape, 760x540 image, 1024x720 control panel and keyboard focus");

  await focusNative(pageA);
  await (await controller(first.label)).getByRole("button", { name: "3D", exact: true }).click();
  await pageA.locator(".raw-volume-stage canvas").first().waitFor({ timeout: 60000 });
  await until(async () => await pageA.locator(".raw-volume").getAttribute("data-source-id") === a.id &&
    await pageA.getByRole("button", { name: /Export PNG/ }).isEnabled(), "verified volume ready");
  await pageA.getByRole("button", { name: "3D view", exact: true }).click();
  await pageA.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture(pageA, "06-detached-volume");
  await pageA.getByRole("button", { name: /Export PNG/ }).click();
  await until(async () => fs.stat(path.join(figure, "manifest.json")).then(() => true, () => false), "detached figure export");
  const manifest = JSON.parse(await fs.readFile(path.join(figure, "manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, "loci.volume-figure/v2");
  assert.equal(manifest.source.source_id, a.id);
  assert.equal(manifest.source.source_sha256, a.sha256);
  passed.push("detached raw volume renders under the enforced 32 MiB aggregate estimate and exports a source-bound v2 PNG figure");

  await main.evaluate((target) => window.lociImageWindows.close(target), second.target);
  await assert.rejects(main.evaluate((target) => window.lociImageWindows.execute(target, "source_annotations", { source_id: target.sourceId }), second.target));
  await main.getByLabel("Open source in a new view", { exact: true }).selectOption(a.id);
  await main.getByRole("button", { name: "Open selected source", exact: true }).click();
  await until(async () => (await state()).views.length === 2, "same-source second view registered");
  views = (await state()).views;
  assert.equal(new Set(views.map((view) => view.target.viewId)).size, 2);
  assert.ok(views.every((view) => view.target.sourceId === a.id));
  const twin = views.find((view) => view.target.viewId !== first.target.viewId);
  const pageTwin = await imagePage(twin.target.viewId); await readyImage(pageTwin);
  passed.push("closed target is revoked; two same-source views have independent identities");

  await nativeA.evaluate((window) => window.webContents.forcefullyCrashRenderer());
  await until(async () => (await state()).views.find((view) => view.target.viewId === first.target.viewId)?.status === "crashed", "crash recovery status");
  const crashed = (await state()).views.find((view) => view.target.viewId === first.target.viewId);
  assert.ok(crashed.target.generation > first.target.generation);
  await assert.rejects(main.evaluate((target) => window.lociImageWindows.execute(target, "source_annotations", { source_id: target.sourceId }), first.target));
  await main.evaluate((target) => window.lociImageWindows.reopen(target), crashed.target);
  await until(async () => (await state()).views.find((view) => view.target.viewId === first.target.viewId)?.status === "ready", "reopened renderer");
  assert.equal((await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id)).annotations.length, 1);
  passed.push("crash revokes old generation, reopens the native view and retains committed annotation");

  await main.getByRole("button", { name: "Return to workspace", exact: true }).click();
  await main.getByRole("button", { name: "Restore image windows", exact: true }).waitFor();
  assert.equal((await state()).views.length, 0);
  await main.evaluate(() => window.lociResearch.openStudy());
  await main.getByRole("button", { name: "Restore image windows", exact: true }).click();
  await until(async () => (await state()).views.length === 2, "restored study layout");
  const restored = await state();
  assert.ok(restored.views.every((view) => view.target.sessionEpoch !== crashed.target.sessionEpoch));
  assert.ok(restored.views.some((view) => view.initialPresentation?.channels[0].color === "#a020e0" &&
    view.initialPresentation?.channels[0].opacity === 0.37), "edited display survives layout restore");
  assert.equal((await main.evaluate((id) => window.lociResearch.execute("source_annotations", { source_id: id }), a.id)).annotations.length, 1);
  passed.push("explicit study reopen changes session epoch; local layout restores two source/hash-bound windows");
  await capture(main, "07-restored-control-panel");
  // Modality controls use declared metadata; all fixtures here are generated, non-clinical sources.
  await main.getByRole("button", { name: "Return to workspace", exact: true }).click();
  await main.locator(".research-sources").getByRole("button", { name: /^synthetic-rgb\.tif/ }).click();
  await main.getByRole("button", { name: "Detach image", exact: true }).click();
  await until(async () => (await state()).views.length === 1, "RGB detached view");
  const rgbEntry = (await state()).views[0];
  const rgbPage = await imagePage(rgbEntry.target.viewId); await readyImage(rgbPage);
  const rgbControls = await controller(rgbEntry.label);
  await rgbControls.getByLabel("RGB white point", { exact: true }).waitFor();
  assert.equal(await rgbControls.getByRole("button", { name: "3D", exact: true }).count(), 0);
  const centerPixel = (page) => page.locator(".image-viewport canvas").first().evaluate((canvas) =>
    [...canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3));
  const rgbBefore = await centerPixel(rgbPage);
  assert.ok(rgbBefore.every((value, index) => Math.abs(value - [128, 64, 32][index]) <= 2), `RGB source tone: ${rgbBefore}`);
  // The 4096-square RGB fixture exercises a real decode beyond the 150 ms loading
  // indicator delay; tiny fixtures can finish before there is an operation to stop.
  // Stop the actual replacement as soon as its UI button appears; no fake decoder
  // or injected delay. Keep this view stopped while another source loads and renders.
  await rgbPage.evaluate(() => {
    window.__localStopEvidence = null;
    const observer = new MutationObserver(() => {
      const button = [...document.querySelectorAll("button")].find(node => node.textContent.trim() === "Stop loading");
      if (!button) return;
      observer.disconnect();
      window.__localStopEvidence = { prepared: document.querySelector(".image-viewport")?.dataset.prepared };
      button.click();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await rgbControls.getByLabel("RGB white point", { exact: true }).fill("128");
  await rgbControls.getByLabel("RGB white point", { exact: true }).press("Tab");
  await rgbPage.getByRole("button", { name: "Retry view", exact: true }).waitFor();
  assert.deepEqual(await rgbPage.evaluate(() => window.__localStopEvidence), { prepared: "false" });
  await capture(main, "08-rgb-controls"); await capture(rgbPage, "09-rgb-stopped");

  await main.getByLabel("Open source in a new view", { exact: true }).selectOption(medical.id);
  await main.getByRole("button", { name: "Open selected source", exact: true }).click();
  await until(async () => (await state()).views.length === 2, "medical view registered");
  const medicalEntry = (await state()).views.find((view) => view.target.sourceId === medical.id);
  const medicalPage = await imagePage(medicalEntry.target.viewId); await readyImage(medicalPage);
  const medicalControls = await controller(medicalEntry.label);
  const level = medicalControls.getByLabel(`${medicalEntry.label} channel 1 level`, { exact: true });
  const width = medicalControls.getByLabel(`${medicalEntry.label} channel 1 window`, { exact: true });
  await level.fill("40"); await level.press("Tab");
  await width.fill("400"); await width.press("Tab");
  await until(async () => (await centerPixel(medicalPage)).every((value) => Math.abs(value - 166) <= 2), "medical window/level maps native intensity 100 to 166/255");
  assert.match(await medicalControls.innerText(), /LPS/);
  await capture(main, "10-medical-controls");
  await medicalControls.getByRole("button", { name: "3D", exact: true }).click();
  await until(async () => await medicalPage.locator(".raw-volume").getAttribute("data-transfer-ranges") === "-160:240", "medical native window reaches volume transfers");
  await medicalControls.getByLabel(`${medicalEntry.label} volume mode`, { exact: true }).selectOption("mip");
  await until(async () => await medicalPage.getByLabel("3D rendering mode", { exact: true }).inputValue() === "mip", "main mode reaches image renderer");
  await medicalPage.getByLabel("3D rendering mode", { exact: true }).selectOption("normal_shading");
  await until(async () => await medicalControls.getByLabel(`${medicalEntry.label} volume mode`, { exact: true }).inputValue() === "normal_shading", "image mode reaches main controls");
  await until(async () => await medicalPage.getByRole("button", { name: /Export PNG/ }).isEnabled(), "medical volume ready for capture");
  await medicalPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture(medicalPage, "11-medical-volume");
  passed.push("medical scalar volume uses declared LPS geometry, independently checked native window/level and bidirectional 3D render controls");
  assert.equal(await rgbPage.getByRole("button", { name: "Retry view", exact: true }).count(), 1,
    "Opening and rendering the second source must not restart the stopped view");
  await rgbPage.getByRole("button", { name: "Retry view", exact: true }).click();
  await readyImage(rgbPage);
  await until(async () => (await centerPixel(rgbPage)).every((value, index) => Math.abs(value - [255, 128, 64][index]) <= 2), "retried RGB tone reaches exact pixels");
  await capture(rgbPage, "12-rgb-retry-tone");
  passed.push("RGB shared tone, local stop during replacement, independent medical rendering and explicit RGB retry to verified pixels");
  await focusNative(medicalPage);
  await until(async () => (await state()).target?.viewId === medicalEntry.target.viewId, "restore medical target after retry");
  await main.getByRole("button", { name: "Return to workspace", exact: true }).click();
  await main.getByLabel(`Image viewer: ${medical.name}`, { exact: true }).waitFor();
  passed.push("return to full analysis workspace preserves the active medical source");
  await main.locator(".research-sources").getByRole("button", { name: /^synthetic-volume-a\.ome\.tif/ }).click();
  await selectWorkbenchTool(main, "Display");
  await main.locator("details.source-information > summary").click();
  await main.getByLabel("Open as", { exact: true }).selectOption("volume");
  await main.getByRole("button", { name: /Export PNG/ }).waitFor({ timeout: 60000 });
  await main.getByLabel("3D rendering mode", { exact: true }).selectOption("mip");
  const volumeChannel = main.locator("details.raw-volume-channel").first();
  if (!await volumeChannel.evaluate(node => node.open)) await volumeChannel.locator(":scope > summary").click();
  const volumeOpacity = main.locator(".raw-volume-opacity input").first();
  await volumeOpacity.fill("0.61");
  await main.getByRole("button", { name: "Detach image", exact: true }).click();
  await main.getByRole("heading", { name: "Image controls", exact: true }).waitFor();
  const volumeEntry = (await state()).views[0];
  const volumePage = await imagePage(volumeEntry.target.viewId);
  await until(async () => (await volumePage.evaluate(() => window.lociImageWindows.presentation()))?.presentation.mode === "volume", "main volume mode transferred");
  const volumeSeed = (await volumePage.evaluate(() => window.lociImageWindows.presentation())).presentation;
  assert.equal(volumeSeed.volumeDisplay.renderMode, "mip");
  assert.equal(volumeSeed.channels[0].opacity, 0.61);
  await until(async () => await volumePage.getByRole("button", { name: /Export PNG/ }).isEnabled(), "transferred volume rendered");
  assert.equal(await volumePage.locator(".raw-volume-opacity output").first().textContent(), "0.61");
  assert.equal(await main.getByLabel(`${volumeEntry.label} channel 1 opacity value`, { exact: true }).textContent(), "0.61");
  await capture(volumePage, "13-transferred-main-volume");
  passed.push("main volume transfer preserves MIP mode and channel opacity through actual detached rendering");
  assert.deepEqual(errors, []);
  report = { status: "passed", source, identity, fixtures: fixtureHashes, passed, screenshots, annotation: polygon,
    not_exercised: ["physical second monitor disconnect/reconnect", "clinical data", "all formats/platforms", "detached immutable-result correction UI"], errors };
} catch (error) {
  await capture(main, "failure-main").catch(() => {});
  report = { status: "failed", source, identity, fixtures: fixtureHashes, passed, screenshots, error: String(error.stack ?? error), errors };
  process.exitCode = 1;
} finally {
  report.nativeFullscreen = await app.evaluate(({ BrowserWindow }) => ({
    events: globalThis.__fullscreenTrace ?? [],
    final: BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), fullscreen: w.isFullScreen(), fullscreenable: w.isFullScreenable() })),
  })).catch(() => null);
  report.memory = await sampler.stop();
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  await app.close();
  console.log(JSON.stringify({ root, status: report.status, passed: passed.length, error: report.error }));
}
