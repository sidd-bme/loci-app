/** Packaged local-stop isolation on owned synthetic RGB and medical sources. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
const repo = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
assert.ok(bundle, "Set LOCI_PACKAGED_APP to the exact qualification candidate");
const root = path.join(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repo, ".loci/evidence/viewer-stop"), new Date().toISOString().replaceAll(":", "-"));
await fs.mkdir(root, { recursive: true });
const rgb = path.join(root, "synthetic-rgb.tif"), medical = path.join(root, "synthetic-medical.nii");
const generator = path.join(root, "fixture.py");
await fs.writeFile(generator, `from pathlib import Path
import numpy as np
import tifffile
import SimpleITK as sitk
root=Path(__file__).parent
rgb=np.empty((4096,4096,3),dtype=np.uint8); rgb[:]=[128,64,32]
tifffile.imwrite(root/'synthetic-rgb.tif',rgb,photometric='rgb')
a=np.full((12,128,160),100,dtype=np.int16)
image=sitk.GetImageFromArray(a); image.SetSpacing((0.7,0.8,2.5)); image.SetOrigin((10,20,30))
sitk.WriteImage(image,str(root/'synthetic-medical.nii'))
`);
execFileSync(path.join(repo, "engine/.venv/bin/python"), [generator]);
const hash = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const report = { status: "running", source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), identity: {
  executable: await hash(path.join(bundle, "Contents/MacOS/Loci")), asar: await hash(path.join(bundle, "Contents/Resources/app.asar")),
  worker: await hash(path.join(bundle, "Contents/Resources/loci-engine/loci-engine")), harness: await hash(import.meta.filename),
}, fixtures: { rgb: await hash(rgb), medical: await hash(medical) }, errors: [], passed: [] };
const app = await electron.launch({ executablePath: path.join(bundle, "Contents/MacOS/Loci"), args: [`--user-data-dir=${path.join(root, "user-data")}`], timeout: 60000 });
const main = await app.firstWindow();
app.on("window", page => page.on("pageerror", e => report.errors.push(e.message)));
main.on("pageerror", e => report.errors.push(e.message));
const state = () => main.evaluate(() => window.lociImageWindows.state());
async function until(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await main.waitForTimeout(60); } throw new Error(`Timed out: ${label}`); }
async function imagePage(id) { let found; await until(async () => {
  for (const page of app.windows()) if (page !== main && !page.isClosed()) {
    const s = await page.evaluate(() => window.lociImageWindows?.state()).catch(() => null);
    if (s?.target?.viewId === id) { found = page; return true; }
  } return false;
}, "native image window"); return found; }
const centre = page => page.locator(".image-viewport canvas").evaluate(c => [...c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data].slice(0, 3));
try {
  await app.evaluate(({ dialog, BrowserWindow }, paths) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 40, width: 1200, height: 800 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, [rgb, medical]);
  await main.getByRole("button", { name: "Open images", exact: true }).click();
  await main.locator(".research-sources").getByRole("button", { name: /^synthetic-rgb\.tif/ }).click();
  const snapshot = await main.evaluate(() => window.lociResearch.getSnapshot());
  const med = snapshot.sources.find(s => s.name === path.basename(medical)); assert.ok(med);
  await main.getByRole("button", { name: "Detach image", exact: true }).click();
  await until(async () => (await state()).views.length === 1, "RGB window registration");
  const rgbView = (await state()).views[0], a = await imagePage(rgbView.target.viewId);
  await a.getByRole("button", { name: "Stop loading", exact: true }).click();
  await a.getByRole("button", { name: "Retry view", exact: true }).waitFor();
  report.passed.push("stop real RGB loading through its visible native-view control");
  await a.screenshot({ path: path.join(root, "rgb-stopped.png") });
  await main.getByLabel("Open source in a new view", { exact: true }).selectOption(med.id);
  await main.getByRole("button", { name: "Open selected source", exact: true }).click();
  await until(async () => (await state()).views.length === 2, "independent medical view");
  const medView = (await state()).views.find(v => v.target.sourceId === med.id), b = await imagePage(medView.target.viewId);
  const controls = main.getByRole("region", { name: `Controls for ${medView.label}`, exact: true });
  for (const [setting, value] of [["level", "40"], ["window", "400"]]) {
    const input = controls.getByLabel(`${medView.label} channel 1 ${setting}`, { exact: true });
    await input.fill(value); await input.press("Tab");
  }
  await b.locator('.image-viewport[data-prepared="true"]').waitFor();
  await until(async () => (await centre(b)).every(v => Math.abs(v - 166) <= 2), "medical native intensity 100 maps to 166 with level 40/window 400");
  assert.equal(await a.getByRole("button", { name: "Retry view", exact: true }).count(), 1);
  await b.screenshot({ path: path.join(root, "medical-independent.png") });
  report.passed.push("medical decode and window/level finish with independently expected pixels while RGB remains stopped");
  await a.getByRole("button", { name: "Retry view", exact: true }).click();
  await a.locator('.image-viewport[data-prepared="true"]').waitFor();
  await until(async () => (await centre(a)).every((v, i) => Math.abs(v - [128, 64, 32][i]) <= 2), "retried RGB source pixels");
  await a.screenshot({ path: path.join(root, "rgb-retried.png") });
  assert.equal(await hash(rgb), report.fixtures.rgb); assert.equal(await hash(medical), report.fixtures.medical);
  assert.deepEqual(report.errors, []);
  report.passed.push("explicit retry recovers exact RGB pixels; source files remain unchanged");
  report.status = "passed";
} catch (error) { report.status = "failed"; report.failure = String(error.stack ?? error); process.exitCode = 1;
  await main.screenshot({ path: path.join(root, "failure-main.png") }).catch(() => {});
} finally { await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n"); await app.close(); }
console.log(JSON.stringify({ root, status: report.status, passed: report.passed, failure: report.failure }));
