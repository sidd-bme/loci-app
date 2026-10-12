import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect } from "playwright/test";

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "../..");
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.ok(process.env.LOCI_PACKAGED_APP, "Set LOCI_PACKAGED_APP to the identified candidate.");
assert.ok(process.env.LOCI_QA_OUTPUT_ROOT, "Set LOCI_QA_OUTPUT_ROOT to retained evidence.");
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP);
const executablePath = path.join(appBundle, "Contents/MacOS/Loci");
const runRoot = await fs.mkdtemp(path.join(await fs.mkdir(path.resolve(process.env.LOCI_QA_OUTPUT_ROOT), { recursive: true }).then(() => path.resolve(process.env.LOCI_QA_OUTPUT_ROOT)), "color-"));
const screenshots = path.join(runRoot, "screenshots");
await fs.mkdir(screenshots);
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
const patch = (await run("git", ["diff", "HEAD", "--", "desktop"], { cwd: projectRoot, maxBuffer: 8 * 1024 * 1024 })).stdout;
await fs.writeFile(path.join(runRoot, "tested-desktop.patch"), patch);
const report = {
  timestamp: new Date().toISOString(), harness: import.meta.filename,
  harness_sha256: await sha256(import.meta.filename), app_bundle: appBundle,
  executable_sha256: await sha256(executablePath),
  asar_sha256: await sha256(path.join(appBundle, "Contents/Resources/app.asar")),
  worker_sha256: await sha256(path.join(appBundle, "Contents/Resources/loci-engine/loci-engine")),
  source_head: await git("rev-parse", "HEAD"), source_status: await git("status", "--porcelain"),
  source_patch_sha256: await sha256(path.join(runRoot, "tested-desktop.patch")),
  fixtures: [], cases: [], exports: [], renderer_errors: [],
};
const modes = ["blend", "normal_shading", "mip", "average", "minip"];
const names = ["Synthetic A", "Synthetic B", "Synthetic C", "Synthetic D"];
const colors = ["#ff00ff", "#00ff00", "#00ffff", "#ffff00"];
const expectedHues = [[1, 0, 1], [0, 1, 0], [0, 1, 1], [1, 1, 0]];
const generator = path.join(runRoot, "generate.py");
await fs.writeFile(generator, `import numpy as np\nimport tifffile\nfrom pathlib import Path\nroot = Path(${JSON.stringify(runRoot)})\nfor n, reverse in [(1,False),(2,False),(3,False),(4,False),(4,True)]:\n    v = np.zeros((n,32,48,64), dtype=np.uint8)\n    for c in range(n):\n        v[c,:,:,round(64*c/n):round(64*(c+1)/n)] = 192\n    if n == 2:\n        v[:,:,:,24:40] = 128\n    if n == 4:\n        v[:,:,:,28:36] = 128\n    names = ['Synthetic A','Synthetic B','Synthetic C','Synthetic D'][:n]\n    if reverse:\n        v = v[::-1].copy()\n        names = names[::-1]\n    tifffile.imwrite(root / f'{n}ch-{reverse}.ome.tiff', v, ome=True, photometric='minisblack', metadata={'axes':'CZYX','PhysicalSizeX':1.0,'PhysicalSizeY':1.0,'PhysicalSizeZ':1.0,'Channel':{'Name':names}})\n`);
await run(path.join(projectRoot, "engine/.venv/bin/python"), [generator]);

let app, page;
// Read the central scanline of a frontal, full-depth synthetic slab. Bounds come
// from its lit silhouette; sample well inside regions, away from interpolation
// edges, orientation axes and overlays. This is an independent fixture oracle.
const pixelReader = path.join(runRoot, "read_pixels.py");
await fs.writeFile(pixelReader, `import json, sys, hashlib
from io import BytesIO
from PIL import Image, ImageCms
im = Image.open(sys.argv[1])
icc = im.info.get('icc_profile')
raw = im.convert('RGB')
reference = Image.open(sys.argv[4]).info.get('icc_profile') if len(sys.argv) > 4 else None
if reference:
    im = ImageCms.profileToProfile(im.convert('RGB'), ImageCms.ImageCmsProfile(BytesIO(icc)) if icc else ImageCms.createProfile('sRGB'), ImageCms.ImageCmsProfile(BytesIO(reference)), outputMode='RGB')
elif icc:
    im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(BytesIO(icc)), ImageCms.createProfile('sRGB'), outputMode='RGB')
else:
    im = im.convert('RGB')
width, height = im.size
y = height // 2
fractions, bounds = json.loads(sys.argv[2]), json.loads(sys.argv[3])
if bounds is None:
    lit = [x for x in range(int(width*.2), int(width*.8)) if max(im.getpixel((x,y))) > 35]
    if not lit: raise ValueError('No rendered slab on central scanline')
    bounds = [lit[0], lit[-1]]
rgb = []
raw_rgb = []
for fraction in fractions:
    x = round(bounds[0] + fraction * (bounds[1] - bounds[0]))
    pixels = [im.getpixel((x+dx,y+dy)) for dy in range(-2,3) for dx in range(-2,3)]
    rgb.append([sorted(p[c] for p in pixels)[12] for c in range(3)])
    raw_pixels = [raw.getpixel((x+dx,y+dy)) for dy in range(-2,3) for dx in range(-2,3)]
    raw_rgb.append([sorted(p[c] for p in raw_pixels)[12] for c in range(3)])
print(json.dumps({'rgb':rgb,'raw_rgb':raw_rgb,'bounds':bounds,'width':width,'height':height,'sample_space':'reference screen profile' if reference else 'sRGB','embedded_icc_sha256':hashlib.sha256(icc).hexdigest() if icc else None}))
`);
let pixelSampleIndex = 0;
async function sample(bytes, fractions, bounds, reference) {
  // OS screenshots carry a monitor ICC profile, whereas VTK canvas PNGs are
  // sRGB. Convert using the embedded profile before comparing their numbers.
  // Retain both original bytes and the exact conversion helper as evidence.
  const input = path.join(runRoot, `pixel-input-${pixelSampleIndex++}.png`);
  await fs.writeFile(input, bytes);
  const result = await run(path.join(projectRoot, "engine/.venv/bin/python"),
    [pixelReader, input, JSON.stringify(fractions), JSON.stringify(bounds ?? null), ...(reference ? [reference] : [])]);
  return { ...JSON.parse(result.stdout), input };
}

function assertHue(rgb, expected, label, minimumSignal = 35) {
  // The PNG is composited over the neutral viewport background. A translucent
  // pure green legitimately contains equal R/B background (e.g. 11,117,11).
  // Remove that neutral floor for chromatic regions; a white-only regression
  // then has zero chromatic signal and fails, rather than passing a hue ratio.
  const neutralFloor = expected.includes(0) ? Math.min(...rgb) : 0;
  const signal = rgb.map(v => v - neutralFloor);
  const peak = Math.max(...signal);
  assert.ok(peak > minimumSignal, `${label}: expected visible signal, got ${rgb}`);
  expected.forEach((v, i) => assert.ok(Math.abs(signal[i] / peak - v) < .08,
    `${label}: expected normalized hue ${expected}, got ${rgb}`));
}

async function capture(label, fractions, bounds) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bytes = await page.locator(".raw-volume-stage").screenshot({ path: path.join(screenshots, `${label}.png`) });
  const result = await sample(bytes, fractions, bounds);
  report.cases.push({ label, ...result });
  return result;
}
async function setNumber(name, field, value) {
  const input = page.getByLabel(`${name} ${field}`, { exact: true });
  await input.fill(String(value)); await input.press("Tab");
}
async function exportFigure(label, expectedMode) {
  const target = path.join(runRoot, `${label}.loci-figure`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
  await page.getByRole("button", { name: "Export PNG…", exact: true }).click();
  await expect(page.locator(".raw-volume-export-status")).toContainText(`${label}.loci-figure`);
  const manifest = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
  const png = await fs.readFile(path.join(target, "image.png"));
  assert.equal(manifest.schema_version, "loci.volume-figure/v2");
  assert.equal(manifest.artifact.sha256, await sha256(path.join(target, "image.png")));
  assert.equal(manifest.artifact.size_bytes, png.length);
  const mpr = expectedMode === null;
  assert.equal(manifest.representation.channel_compositing, mpr ? null : "opacity-weighted-channels/v1");
  assert.equal(manifest.representation.blend_mode, expectedMode);
  assert.equal(manifest.representation.projection_reducer, expectedMode === "average" ? "sample-distance-weighted-mean/v1" : null);
  assert.equal(manifest.representation.quality, mpr ? null : 50);
  assert.equal(manifest.representation.shading, expectedMode === "normal_shading");
  assert.deepEqual(manifest.representation.lighting, expectedMode === "normal_shading"
    ? { ambient: .22, diffuse: .68, specular: .25, specular_power: 20, gradient_opacity: false } : null);
  assert.equal(manifest.source.source_sha256, report.fixtures.at(-1).sha256);
  report.exports.push({ target, manifest_sha256: await sha256(path.join(target, "manifest.json")), image_sha256: manifest.artifact.sha256, representation: manifest.representation });
  return { target, manifest, png };
}
try {
  for (const [n, reverse] of [[2, false], [1, false], [3, false], [4, false], [4, true]]) {
    const id = `${n}ch-${reverse ? "True" : "False"}`;
    const fixture = path.join(runRoot, `${id}.ome.tiff`);
    report.fixtures.push({ path: fixture, sha256: await sha256(fixture) });
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(runRoot, `profile-${id}`)}`], timeout: 60_000 });
    page = await app.firstWindow(); page.setDefaultTimeout(30_000);
    page.on("pageerror", error => report.renderer_errors.push(String(error)));
    page.on("console", message => { if (message.type() === "error") report.renderer_errors.push(message.text()); });
    await app.evaluate(({ BrowserWindow, dialog }, fixture) => {
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, fixture);
    await page.getByRole("button", { name: "Open images", exact: true }).click();
    for (let c = 1; c < n; c++) await page.getByLabel(`Channel ${c + 1} visible`, { exact: true }).check();
    // Existing source-view persistence debounces before the separate volume worker reads it.
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "3D volume", exact: true }).click();
    await page.locator(".raw-volume-stage canvas").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "3D view", exact: true }).click();
    for (let c = 0; c < n; c++) {
      await page.locator("details.raw-volume-channel").filter({ hasText: names[c] }).locator("summary").click();
      await page.getByLabel(`${names[c]} colour`, { exact: true }).fill(colors[c]);
      await setNumber(names[c], "low", 0); await setNumber(names[c], "high", 255);
    }
    const fractions = n === 2 ? [.18, .5, .82] : Array.from({ length: n }, (_, c) => (c + .5) / n);
    if (n === 4) fractions.push(.5);
    for (const mode of modes) {
      await page.getByLabel("3D rendering mode", { exact: true }).selectOption(mode);
      const result = await capture(`${id}-${mode}`, fractions);
      if (mode === "average") {
        // Every fixture region is constant through Z: its distance-weighted
        // mean must equal its maximum, including the fourth scalar component.
        const mip = report.cases.find(entry => entry.label === `${id}-mip`);
        assert.ok(mip);
        assert.equal(result.embedded_icc_sha256, mip.embedded_icc_sha256);
        result.raw_rgb.forEach((rgb, i) => rgb.forEach((v, c) => assert.ok(Math.abs(v - mip.raw_rgb[i][c]) <= 3,
          `Constant-depth Average differs from MIP at ${id} region ${i}: ${rgb} vs ${mip.rgb[i]}`)));
      }
      if (n === 2) {
        assertHue(result.rgb[0], expectedHues[0], `${id}/${mode}/exclusive A`);
        // A flat interior has no gradient normal: only the specified ambient
        // lighting remains. Equal complementary channels yield .5 * .22 * 255.
        const ambientOverlap = .5 * .22 * 255;
        if (mode === "normal_shading") result.rgb[1].forEach(v =>
          assert.ok(Math.abs(v - ambientOverlap) <= 3, "Flat overlap must match recorded ambient lighting"));
        assertHue(result.rgb[1], [1, 1, 1], `${id}/${mode}/equal overlap`,
          mode === "normal_shading" ? ambientOverlap - 3 : 35);
        assertHue(result.rgb[2], expectedHues[1], `${id}/${mode}/exclusive B`);
        const exported = await exportFigure(`${id}-${mode}`, mode);
        // Transform the exported sRGB image FORWARD into the screenshot's
        // profile. Inverting an 8-bit monitor capture loses precision at gamut
        // boundaries and cannot support an exact code-value comparison.
        const pixels = await sample(exported.png, fractions, undefined, result.input);
        pixels.rgb.forEach((rgb, i) => rgb.forEach((v, c) => assert.ok(Math.abs(v - result.raw_rgb[i][c]) <= 3, "Exported PNG disagrees with displayed slab")));
      } else {
        result.rgb.slice(0, n).forEach((rgb, c) => assertHue(rgb, expectedHues[c], `${id}/${mode}/channel ${c}`));
        if (n === 4) {
          // Equal magenta + green + cyan + yellow = (0.5, 0.75, 0.5).
          assertHue(result.rgb[4], [2 / 3, 1, 2 / 3], `${id}/${mode}/four-channel overlap`);
          if (reverse) {
            const prior = report.cases.find(entry => entry.label === `4ch-False-${mode}`);
            assert.ok(prior);
            assert.equal(result.embedded_icc_sha256, prior.embedded_icc_sha256);
            result.raw_rgb.forEach((rgb, i) => rgb.forEach((v, c) => assert.ok(Math.abs(v - prior.raw_rgb[i][c]) <= 3,
              "Reordering components changed the rendered mixture")));
          }
        }
      }
    }
    if (n === 2) {
      await page.getByLabel("3D rendering mode", { exact: true }).selectOption("mip");
      const original = await capture("2ch-original", fractions);
      await page.getByLabel("Synthetic A visible", { exact: true }).uncheck();
      let hidden = await capture("2ch-hidden-A", fractions, original.bounds);
      assert.ok(Math.max(...hidden.rgb[0]) < 30); assertHue(hidden.rgb[1], expectedHues[1], "hidden A overlap");
      await page.getByLabel("Synthetic B visible", { exact: true }).uncheck();
      hidden = await capture("2ch-all-hidden", fractions, original.bounds);
      hidden.rgb.forEach(rgb => assert.ok(Math.max(...rgb) < 30, "All hidden must be background"));
      await page.getByLabel("Synthetic A visible", { exact: true }).check();
      await page.getByLabel("Synthetic B visible", { exact: true }).check();
      await page.getByLabel("Synthetic A opacity", { exact: true }).press("Home");
      const zero = await capture("2ch-zero-opacity-A", fractions, original.bounds);
      assert.ok(Math.max(...zero.rgb[0]) < 30); assertHue(zero.rgb[1], expectedHues[1], "zero opacity A overlap");
      await page.getByLabel("Synthetic A opacity", { exact: true }).press("End");
      await setNumber(names[0], "low", 200);
      const below = await capture("2ch-below-window-A", fractions, original.bounds);
      assert.ok(Math.max(...below.rgb[0]) < 30); assertHue(below.rgb[1], expectedHues[1], "below window A overlap");
      await setNumber(names[0], "low", 0); await setNumber(names[0], "gamma", 2);
      const gamma = await capture("2ch-gamma-A", fractions, original.bounds);
      assertHue(gamma.rgb[0], expectedHues[0], "gamma preserves exclusive hue");
      assert.ok(Math.abs(gamma.rgb[1][0] - gamma.rgb[1][1]) > 10, "Unequal transfer opacity must change overlap mixture");
      await setNumber(names[0], "gamma", 1);
      const preserved = report.exports[0];
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, preserved.target);
      await page.getByRole("button", { name: "Export PNG…", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("already exists");
      assert.equal(await sha256(path.join(preserved.target, "manifest.json")), preserved.manifest_sha256);
      assert.equal(await sha256(path.join(preserved.target, "image.png")), preserved.image_sha256);
      await page.getByRole("button", { name: "MPR", exact: true }).click();
      const mprExport = await exportFigure("2ch-mpr", null);
      const requestManifest = structuredClone(mprExport.manifest);
      delete requestManifest.artifact;
      delete requestManifest.software.application;
      delete requestManifest.software.application_version;
      const staleTarget = path.join(runRoot, "stale-source.loci-figure");
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, staleTarget);
      const staleError = await page.evaluate(async request => {
        try { await window.lociResearch.exportVolumeFigure(request); return null; }
        catch (error) { return String(error); }
      }, {
        schema_version: "loci.volume-figure-request/v1",
        source_id: requestManifest.source.source_id, source_sha256: "0".repeat(64),
        width_px: requestManifest.figure.width_px, height_px: requestManifest.figure.height_px,
        png_base64: mprExport.png.toString("base64"), manifest: requestManifest,
      });
      assert.match(staleError ?? "", /source changed/i);
      await assert.rejects(fs.stat(staleTarget), { code: "ENOENT" });
      report.cases.push({ label: "stale-source-export-rejected", error: staleError });
      await page.screenshot({ path: path.join(screenshots, "mpr-export.png") });
    }
    assert.equal(await sha256(fixture), report.fixtures.at(-1).sha256, "Source fixture changed");
    await app.close(); app = null; page = null;
  }
  assert.deepEqual(report.renderer_errors, [], "Renderer/shader errors must not be swallowed");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1;
  if (page) try { await page.screenshot({ path: path.join(screenshots, "failure.png") }); }
  catch (captureError) { report.capture_error = String(captureError); }
} finally {
  if (app) try { await app.close(); } catch (error) { report.close_error = String(error); report.status = "failed"; process.exitCode = 1; }
  await fs.writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ runRoot, status: report.status, cases: report.cases.length, exports: report.exports.length, error: report.error }));
