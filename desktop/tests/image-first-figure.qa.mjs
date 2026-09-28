import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

// Synthetic source data and independent pixel checks; no performance claim.
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
assert.ok(windows || process.platform === "darwin", "Use a supported native desktop host.");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use the documented Node 24 baseline.");
const bundle = process.env.LOCI_PACKAGED_APP;
const output = process.env.LOCI_QA_OUTPUT_ROOT;
assert.ok(bundle && path.isAbsolute(bundle), "LOCI_PACKAGED_APP must identify the native app bundle.");
assert.ok(output && path.isAbsolute(output), "Choose an absolute qualification output root.");
const relativeOutput = path.relative(root, output);
assert.ok(relativeOutput.startsWith(`..${path.sep}`) || relativeOutput.startsWith(`.loci${path.sep}`),
  "Keep generated evidence outside Git or under the ignored .loci directory.");
const executable = windows ? path.join(bundle, "Loci.exe") : path.join(bundle, "Contents/MacOS/Loci");
const resources = path.join(bundle, windows ? "resources" : "Contents/Resources");
const worker = path.join(resources, "loci-engine", windows ? "loci-engine.exe" : "loci-engine");
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(root, "engine/.venv", windows ? "Scripts/python.exe" : "bin/python");
const runRoot = path.join(output, new Date().toISOString().replaceAll(/[:.]/g, "-"));
const shots = path.join(runRoot, "screenshots");
await fs.mkdir(shots, { recursive: true });
const scalar = path.join(runRoot, "calibrated-two-channel.ome.tiff");
const rgb = path.join(runRoot, "native-rgb16.tiff");
const medical = path.join(runRoot, "medical-geometry-phantom.nii");
const study = path.join(runRoot, "figure-controls.loci-study");
const png = path.join(runRoot, "scalar-figure.png");
const tiff = path.join(runRoot, "scalar-figure.tiff");
const rgbTiff = path.join(runRoot, "rgb-tone.tiff");
const references = path.join(runRoot, "references.json");
await run(python, ["-c", String.raw`
import json,sys
from pathlib import Path
import numpy as np
import tifffile
import SimpleITK as sitk
out=Path(sys.argv[1]); h,w=200,320
y,x=np.indices((h,w)); red=(x*65535//(w-1)).astype(np.uint16); green=(y*65535//(h-1)).astype(np.uint16)
data=np.empty((2,2,3,h,w),dtype=np.uint16)
for t in range(2):
 for c,plane in enumerate([red,green]):
  for z in range(3): data[t,c,z]=((plane.astype(np.uint32)+t*333+z*77)%65536).astype(np.uint16)
tifffile.imwrite(out/'calibrated-two-channel.ome.tiff',data,ome=True,metadata={'axes':'TCZYX','PhysicalSizeX':.5,'PhysicalSizeXUnit':'µm','PhysicalSizeY':.75,'PhysicalSizeYUnit':'µm','PhysicalSizeZ':2.,'PhysicalSizeZUnit':'µm','Channel':{'Name':['Reference A','Reference B']}})
rgb=np.stack([red,green,((x+y)*123%65536).astype(np.uint16)],axis=-1)
tifffile.imwrite(out/'native-rgb16.tiff',rgb,photometric='rgb',metadata={'axes':'YXS'})
volume=sitk.GetImageFromArray(np.stack([(x+y+z*100).astype(np.int16) for z in range(3)]))
volume.SetSpacing((.5,.75,2.)); sitk.WriteImage(volume,str(out/'medical-geometry-phantom.nii'))
expected={}
for t,z in [(0,0),(1,2)]:
 records=[]
 for c in range(2):
  plane=data[t,c,z]; lo,hi=float(plane.min()),float(plane.max())
  counts,_=np.histogram(plane,bins=256,range=(lo,hi))
  records.append({'counts':counts.tolist(),'min':lo,'max':hi})
 expected[f'{t}:{z}']=records
(out/'references.json').write_text(json.dumps(expected))
`, runRoot], { maxBuffer: 1024 * 1024 });
async function sha(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const sourceHashes = Object.fromEntries(await Promise.all([scalar, rgb, medical].map(async file => [path.basename(file), await sha(file)])));
const reference = JSON.parse(await fs.readFile(references, "utf8"));
const identity = { checkout_head: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
  checkout_status: (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim(),
  executable_sha256: await sha(executable), worker_sha256: await sha(worker),
  asar_sha256: await sha(path.join(resources, "app.asar")), harness_sha256: await sha(import.meta.filename),
  host_node: process.versions.node, platform: process.platform };
let app, page, destination = png;
const errors = [], consoleErrors = [], network = [];
const evidence = { identity, source_hashes: sourceHashes, histograms: [] };
async function dialogTargets() {
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title === "Add microscopy or medical images") return { canceled: false, filePaths: values.sources };
      if (title === "Open research study") return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => ({ canceled: false,
      filePath: args.at(-1)?.title === "Save research study as" ? values.study : values.destination });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { sources: [scalar, rgb, medical], study, destination });
}
async function idle() {
  await page.waitForFunction(() => Number(document.querySelector('.image-viewport')?.getAttribute('data-cache-bytes')) > 0 &&
    !document.querySelector('.image-view-loading'), null, { timeout: 60_000 });
}
async function choose(file) {
  await page.locator('.research-sources button[data-source-id]').filter({ hasText: path.basename(file) }).click();
  await idle();
  await selectWorkbenchTool(page, "Display");
}
async function number(label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value)); await input.press("Tab");
  assert.notEqual(await input.getAttribute("aria-invalid"), "true", `${label} rejected ${value}`);
}
async function histogram(t, z) {
  // Let the user-visible request finish before issuing the independent read.
  // Both use the bounded histogram lane; a concurrent diagnostic call would
  // supersede the pending UI request rather than observe it.
  await page.getByRole("img", { name: "Channel 1 histogram", exact: true }).waitFor();
  await page.locator('.source-histogram-basis').first().filter({ hasText: `Z ${z + 1}, T ${t + 1}` }).waitFor();
  const binding = await page.evaluate(async ({ name, t, z }) => {
    const snapshot = await window.lociResearch.getSnapshot();
    const source = snapshot.sources.find(item => item.name === name);
    const data = await window.lociResearch.execute("viewer_histogram", { source_id: source.id, t, z, bins: 256 });
    return { source, data };
  }, { name: path.basename(scalar), t, z });
  assert.equal(binding.data.source_sha256, sourceHashes[path.basename(scalar)]);
  assert.equal(binding.data.sample.viewport_dependent, false);
  assert.equal(binding.data.sample.sample_count_per_component, 64000);
  assert.deepEqual(binding.data.histograms.map(item => ({ counts: item.counts, min: item.min, max: item.max })), reference[`${t}:${z}`]);
  evidence.histograms.push({ t, z, source_id: binding.source.id, source_sha256: binding.source.sha256,
    sample: binding.data.sample, records: binding.data.histograms });
}
async function waitSaved(file) {
  await page.locator('.source-export [role="status"]').filter({ hasText: path.basename(file) }).waitFor({ timeout: 60_000 });
  await fs.access(file);
}
async function waitForStudy() {
  const until = performance.now() + 30_000;
  while (performance.now() < until) {
    if (await fs.access(path.join(study, 'study.sqlite3')).then(() => true, () => false)) return;
    await page.waitForTimeout(50);
  }
  throw new Error('Save as did not publish the selected study.');
}
try {
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(runRoot, 'user-data')}`],
    cwd: path.join(root, 'desktop'), timeout: 120_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 800 }));
  await dialogTargets();
  await page.getByRole('button', { name: 'Open images', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  await choose(scalar);
  const time = page.getByLabel('Time frame', { exact: true });
  const z = page.getByLabel('Z plane', { exact: true });
  await time.focus(); await time.press('Home'); await z.focus(); await z.press('Home');
  await idle();
  const firstChannel = page.locator('.source-channel').nth(0);
  await firstChannel.locator(':scope > summary').click();
  await firstChannel.locator('.source-histogram-disclosure > summary').click();
  await histogram(0, 0);
  const graph = page.getByRole('img', { name: 'Channel 1 histogram', exact: true }).locator('path');
  const graphBefore = await graph.getAttribute('d');
  const cameraBefore = await page.locator('.image-viewport').getAttribute('data-camera');
  await page.getByRole('button', { name: '1:1', exact: true }).click();
  await idle();
  assert.notEqual(await page.locator('.image-viewport').getAttribute('data-camera'), cameraBefore);
  assert.equal(await graph.getAttribute('d'), graphBefore, 'Native histogram changed after zoom');
  await time.focus(); await time.press('End');
  await z.focus(); await z.press('End');
  await histogram(1, 2);
  await firstChannel.getByRole('button', { name: 'Trim 1–99%', exact: true }).click();
  const trim = evidence.histograms.at(-1).records[0];
  assert.equal(Number(await page.getByLabel('Channel 1 low', { exact: true }).inputValue()), trim.percentile_1);
  assert.equal(Number(await page.getByLabel('Channel 1 high', { exact: true }).inputValue()), trim.percentile_99);
  await time.focus(); await time.press('Home'); await z.focus(); await z.press('Home');
  await histogram(0, 0);
  for (const channel of [1, 2]) {
    const details = page.locator('.source-channel').nth(channel - 1);
    if (!(await details.evaluate(element => element.open))) await details.locator(':scope > summary').click();
    await page.getByLabel(`Channel ${channel} visible`, { exact: true }).check();
    await number(`Channel ${channel} low`, 0); await number(`Channel ${channel} high`, 65535); await number(`Channel ${channel} gamma`, 1);
    const opacity = page.getByLabel(`Channel ${channel} opacity`, { exact: true });
    await opacity.focus(); await opacity.press('End'); assert.equal(Number(await opacity.inputValue()), 1);
    await page.getByLabel(`Channel ${channel} color`, { exact: true }).fill(channel === 1 ? '#ff0000' : '#00ff00');
  }
  await page.locator('.source-export > summary').click();
  await page.getByLabel('Rendered export DPI').fill('600');
  await page.getByLabel('Include calibrated scale bar').check();
  await page.getByLabel('Include channel legend').check();
  await page.getByLabel('Channel 1 legend label').fill('Reference A');
  await page.getByLabel('Channel 2 legend label').fill('Reference B');
  await page.getByRole('button', { name: 'Export PNG…', exact: true }).click(); await waitSaved(png);
  const originalPng = await sha(png);
  await page.getByRole('button', { name: 'Export PNG…', exact: true }).click();
  const alert = page.locator('.research-alert[role="alert"]');
  await alert.filter({ hasText: /exist|overwrite|destination must be absent/i }).waitFor();
  assert.equal(await sha(png), originalPng, 'Existing figure was overwritten');
  await alert.getByRole('button', { name: 'Dismiss', exact: true }).click();
  destination = tiff; await dialogTargets();
  await page.getByLabel('Rendered export format').selectOption('tiff');
  await page.getByRole('button', { name: 'Export TIFF16…', exact: true }).click(); await waitSaved(tiff);
  await page.screenshot({ path: path.join(shots, 'calibrated-figure-controls.png') });
  await choose(rgb);
  await number('RGB black point', 0); await number('RGB white point', 65535); await number('RGB gamma', 2);
  const rgbExport = page.locator('.source-export');
  if (!(await rgbExport.evaluate(element => element.open))) await rgbExport.locator(':scope > summary').click();
  await page.getByLabel('Rendered export format').selectOption('tiff');
  destination = rgbTiff; await dialogTargets();
  await page.getByRole('button', { name: 'Export TIFF16…', exact: true }).click(); await waitSaved(rgbTiff);
  await choose(medical);
  const medicalChannel = page.locator('.source-channel').first();
  if (!(await medicalChannel.evaluate(element => element.open))) await medicalChannel.locator(':scope > summary').click();
  await number('Channel 1 window', 400); await number('Channel 1 level', 200);
  assert.equal(Number(await page.getByLabel('Channel 1 low', { exact: true }).inputValue()), 0);
  assert.equal(Number(await page.getByLabel('Channel 1 high', { exact: true }).inputValue()), 400);
  await fileMenuAction(page, 'Save as study…'); await waitForStudy();
  await fileMenuAction(page, 'Open study'); await idle();
  await choose(medical);
  const reopened = page.locator('.source-channel').first();
  if (!(await reopened.evaluate(element => element.open))) await reopened.locator(':scope > summary').click();
  assert.equal(Number(await page.getByLabel('Channel 1 window', { exact: true }).inputValue()), 400);
  assert.equal(Number(await page.getByLabel('Channel 1 level', { exact: true }).inputValue()), 200);
  const verification = await run(python, ['-c', String.raw`
import hashlib,json,sys
from pathlib import Path
import numpy as np
import tifffile
from PIL import Image
out=Path(sys.argv[1]); source=tifffile.imread(out/'calibrated-two-channel.ome.tiff')[0,:,0]
expected16=np.stack([source[0],source[1],np.zeros_like(source[0])],axis=-1)
with tifffile.TiffFile(out/'scalar-figure.tiff') as f:
 page=f.pages[0]; raster=page.asarray(); meta=json.loads(page.description)
 assert page.tags['XResolution'].value==(600,1) and page.tags['YResolution'].value==(600,1)
 assert int(page.tags['ResolutionUnit'].value)==2
 np.testing.assert_array_equal(raster[:200],expected16)
 assert meta['figure']['footer']['offset_y']==200 and raster.shape[0]>200
 assert meta['figure']['source_raster']=={'width':320,'height':200}
 assert [x['name'] for x in meta['figure']['request']['channel_labels']]==['Reference A','Reference B']
 scale=meta['figure']['footer']['scale_bar']; assert scale['micrometres_per_output_pixel']==.5
 assert scale['represented_length_um']==scale['bar_xywh'][2]*.5
 x,y,w,h=scale['bar_xywh']; assert np.all(raster[y:y+h,x:x+w]==0)
 assert str(out) not in json.dumps(meta)
with Image.open(out/'scalar-figure.png') as image:
 image.load(); png=np.asarray(image); pngmeta=json.loads(image.info['Loci rendering provenance'])
 np.testing.assert_array_equal(png[:200],np.rint(expected16.astype(np.float64)/257).astype(np.uint8))
 assert abs(image.info['dpi'][0]-600)<.01 and pngmeta['figure']['footer']['offset_y']==200
rgb=tifffile.imread(out/'native-rgb16.tiff').astype(np.float64)
with tifffile.TiffFile(out/'rgb-tone.tiff') as f:
 result=f.asarray(); rgbmeta=json.loads(f.pages[0].description)
 np.testing.assert_array_equal(result,np.rint(np.sqrt(rgb/65535)*65535).astype(np.uint16))
 assert rgbmeta['precision_policy']=='adjusted-uint16-display-codes'
print(json.dumps({'scalar_png_sha256':hashlib.sha256((out/'scalar-figure.png').read_bytes()).hexdigest(),'scalar_tiff_sha256':hashlib.sha256((out/'scalar-figure.tiff').read_bytes()).hexdigest(),'rgb_tiff_sha256':hashlib.sha256((out/'rgb-tone.tiff').read_bytes()).hexdigest(),'all_source_pixels_match':True,'calibration_um_per_pixel':.5,'dpi':600,'rgb_gamma':2}))
`, runRoot], { maxBuffer: 1024 * 1024 });
  evidence.exports = JSON.parse(verification.stdout);
  for (const file of [scalar, rgb, medical]) assert.equal(await sha(file), sourceHashes[path.basename(file)]);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(network, []);
  await fs.writeFile(path.join(runRoot, 'qa-report.json'), JSON.stringify({ status: 'passed', ...evidence }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', runRoot, exports: evidence.exports }));
} catch (error) {
  await page?.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => undefined);
  await fs.writeFile(path.join(runRoot, 'qa-failure.json'), JSON.stringify({ status: 'failed', error: String(error), ...evidence,
    renderer_errors: errors, console_errors: consoleErrors, network_requests: network }, null, 2) + '\n');
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
}
