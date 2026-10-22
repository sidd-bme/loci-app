/** Synthetic packaged SaveAs -> pending review package -> cold reopen journey.
 * Authoring/syntax checking does not run this journey. When the build owner is
 * ready, provide absolute LOCI_PACKAGED_APP, LOCI_QA_OUTPUT_ROOT (an existing
 * internal-volume directory), and optionally LOCI_QA_REFERENCE_PYTHON.
 * Optional LOCI_QA_EXFAT_PARENT explicitly authorizes one new synthetic test
 * directory on that volume; no existing study, source or staging tree is read.
 * No cluster, checkpoint, inference, protected data or network is needed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { selectResultSection, fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
const requestedOutput = process.env.LOCI_QA_OUTPUT_ROOT;
assert.equal(process.platform, "darwin", "This journey qualifies packaged macOS behavior");
assert.ok(bundle && path.isAbsolute(bundle), "Set absolute LOCI_PACKAGED_APP to the candidate");
assert.ok(requestedOutput && path.isAbsolute(requestedOutput), "Set absolute LOCI_QA_OUTPUT_ROOT");
const qaRoot = await fs.realpath(requestedOutput);
assert.equal((await fs.stat(qaRoot)).dev, (await fs.stat(os.homedir())).dev,
  "LOCI_QA_OUTPUT_ROOT must use the internal home volume, keeping app data and outputs internal");
const output = await fs.mkdtemp(path.join(qaRoot, "review-package-workflow-"));
const userData = path.join(output, "user-data");
const original = path.join(output, "synthetic-original.loci-study");
const saved = path.join(output, "synthetic-saved.loci-study");
const rootLabel = "root";
const exported = path.join(output, rootLabel);
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(root, "engine/.venv/bin/python");
const executablePath = path.join(bundle, "Contents/MacOS/Loci");
const workerPath = path.join(bundle, "Contents/Resources/loci-engine/loci-engine");
const receiptPath = path.join(output, "receipt.json");
const report = { schema: "loci.review-package-workflow-qa/v1", status: "running",
  started_at: new Date().toISOString(), checks: {}, errors: [], requests: [], screenshots: [],
  limits: ["Synthetic fixture; no biological or clinical validation", "Compute refresh is tested separately"] };
let app, page, openStudy = original, saveDestination = saved;
await fs.mkdir(userData);
await fs.mkdir(path.join(output, "screenshots"));
const pythonOptions = { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "engine/src") },
  timeout: 60_000, maxBuffer: 8 * 1024 ** 2 };
async function sha(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
const git = async (...args) => (await run("git", args, { cwd: root })).stdout.trim();
const buildIdentity = async () => ({ executable_sha256: await sha(executablePath),
  asar_sha256: await sha(path.join(bundle, "Contents/Resources/app.asar")), worker_sha256: await sha(workerPath) });
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const resultRecords = value => [...value.results].sort((a, b) => a.id.localeCompare(b.id));
async function reviewHistories(ids) {
  return page.evaluate(async resultIds => {
    const records = [];
    for (const result_id of resultIds) records.push(await window.lociResearch.execute("review_history", { result_id }));
    return records;
  }, ids);
}
async function until(read, accept, label, allowAlert = false) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!allowAlert) {
      const alerts = page.locator('.research-alert[role="alert"]');
      if (await alerts.count()) throw new Error(`${label}: ${await alerts.first().textContent()}`);
    }
    const value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) {
  const relative = `screenshots/${name}.png`;
  await page.screenshot({ path: path.join(output, relative) });
  report.screenshots.push({ path: relative, sha256: await sha(path.join(output, relative)) });
}
async function pickers() {
  await app.evaluate(({ dialog }, values) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title !== "Save research study as") throw new Error(`Unexpected save dialog: ${options?.title}`);
      return { canceled: false, filePath: values.saveDestination };
    };
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Open research study") return { canceled: false, filePaths: [values.openStudy] };
      if (options?.title === "Choose a parent folder for the review package")
        return { canceled: false, filePaths: [values.output] };
      throw new Error(`Unexpected open dialog: ${options?.title}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { openStudy, saveDestination, output });
}
async function launch() {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`],
    cwd: path.join(root, "desktop"), timeout: 120_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.errors.push({ kind: "pageerror", message: error.message }));
  page.on("console", message => { if (message.type() === "error") report.errors.push({ kind: "console", message: message.text() }); });
  page.on("request", request => { if (/^https?:/i.test(request.url())) report.requests.push(request.url()); });
  await page.locator("main.image-first-empty,main.image-first-workbench").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1280, 900); window.show(); window.focus(); app.focus({ steal: true });
  });
  await pickers();
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit()); await closed; app = undefined;
}
async function reviewedExportBlocked(items) {
  await page.locator(".research-sources").getByRole("button", { name: "Flat list", exact: true }).click();
  for (const { source_id, result_id } of items) {
    await page.locator(`button[data-source-id="${source_id}"]`).click();
    await page.locator(`button[data-source-id="${source_id}"][aria-current="true"]`).waitFor();
    const result = page.locator(`button[data-result-id="${result_id}"]`);
    await until(() => result.isEnabled(), Boolean, "source-specific saved result available");
    await result.click();
    await page.locator(`button[data-result-id="${result_id}"][aria-pressed="true"]`).waitFor();
    await selectWorkbenchTool(page, "Info");
    await selectResultSection(page, "Review");
    await until(() => page.getByRole("button", { name: "Mark reviewed", exact: true }).isEnabled(), Boolean,
      "pending result loaded and available for researcher review");
    await selectResultSection(page, "Export");
    assert.equal(await page.getByRole("button", { name: "Export result", exact: true }).isEnabled(), false,
      "Provisional material must not enable reviewed export");
  }
}

// Fixture authoring uses real local APIs only to prepare explicitly synthetic
// saved state. All journey mutations after launch use visible UI controls.
const fixtureProgram = String.raw`
import hashlib,json,sys
from pathlib import Path
import numpy as np,tifffile
from loci_engine.quantitative import measure_objects
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench
root=Path(sys.argv[1]); workbench=Workbench(ResearchProject.create(root/'synthetic-original.loci-study','Synthetic RGB review QA'))
items=[]
try:
    yy,xx=np.indices((64,96))
    for index,group in enumerate(('FBS','SFM')):
        pixels=np.stack(((xx*2+yy+index*17)%193,(xx+yy*3+index*23)%193,(xx*5+yy*2+index*31)%193),axis=-1).astype(np.uint8)
        location=root/'sources'/group/'Preview_12.tif'; location.parent.mkdir(parents=True)
        tifffile.imwrite(location,pixels,photometric='rgb',metadata=None)
        source=workbench.import_native(str(location),relative_path=f'{group}/Preview_12.tif')
        selection=dict(x=0,y=0,width=96,height=64,t=0,c=0,z=0,level=0)
        _,geometry,resolved=workbench.load_scalar(source['id'],selection,allow_rgb=True)
        assert resolved==selection
        labels=np.zeros((64,96),np.uint32); labels[8:22,10:29]=3; labels[36:55,55:82]=11
        result=workbench.project.save_result(source_id=source['id'],kind='segmentation',
            arrays={'image':pixels.mean(axis=-1)/255,'labels':labels},
            provenance={'synthetic_fixture':True,'selection':selection,'geometry':geometry.to_dict(),
                'segmentation':{'method':'synthetic-authored-rectangles','count':2},
                'measurements':measure_objects(labels,geometry),'runtime':{'engine':'synthetic-fixture-author'},
                'profile':{'id':'synthetic-qa','version':'1'},'model':{'rights':{'commercial_use':'unknown'}}})
        assert workbench.project.review_state(result['id']) is None
        assert workbench.project.review_history(result['id'])==[]
        items.append({'group':group,'source_path':str(location),'source_sha256':hashlib.sha256(location.read_bytes()).hexdigest(),
            'source_id':source['id'],'result_id':result['id'],'revision_hash':result['revision_hash'],'result':result,
            'label_ids':[3,11],'shape_yx':[64,96],'review':None,'review_history':[]})
    print(json.dumps({'schema':'loci.synthetic-review-fixture/v1','items':items}))
finally:
    workbench.close()
`;

// Independent oracle: no review-package module, skimage boundary function or
// renderer output is used to construct expected labels, boundaries or RGB.
const auditProgram = String.raw`
import csv,hashlib,json,sys
from pathlib import Path
import numpy as np,tifffile
from PIL import Image
from loci_engine.research_project import ResearchProject
root=Path(sys.argv[1]); fixture=json.loads((root/'fixture.json').read_text()); target=root/'root'
manifest_bytes=(target/'manifest.json').read_bytes(); manifest=json.loads(manifest_bytes)
assert manifest['schema']=='loci.review-package/v1' and manifest['status']=='provisional-review-material'
assert manifest['scientific_validation']=='not established' and manifest['root_label']=='root'
assert str(root) not in manifest_bytes.decode()
with (target/'counts.csv').open(newline='') as stream: rows=list(csv.DictReader(stream))
expected_rows=[dict(image_name=f"/root/{item['group']}/Preview_12.tif",cell_count='2',review_status='pending') for item in fixture['items']]
assert sorted(rows,key=lambda r:r['image_name'])==sorted(expected_rows,key=lambda r:r['image_name'])
count=manifest['count_summary']; assert count['path']=='counts.csv'
assert hashlib.sha256((target/count['path']).read_bytes()).hexdigest()==count['sha256']
assert (target/count['path']).stat().st_size==count['size_bytes']
project=ResearchProject(root/'synthetic-saved.loci-study'); images={item['result_id']:item for item in manifest['images']}
assert len(images)==len(manifest['images'])==2
checks=[]; yy,xx=np.indices((64,96))
for index,item in enumerate(fixture['items']):
    source=Path(item['source_path']); assert hashlib.sha256(source.read_bytes()).hexdigest()==item['source_sha256']
    raw=tifffile.imread(source)
    expected_raw=np.stack(((xx*2+yy+index*17)%193,(xx+yy*3+index*23)%193,(xx*5+yy*2+index*31)%193),axis=-1).astype(np.uint8)
    np.testing.assert_array_equal(raw,expected_raw)
    result=project.result(item['result_id']); assert result==item['result']
    assert project.source(item['source_id'],verify=True)['private_path']==str(source)
    assert project.review_state(item['result_id'])==item['review']
    assert project.review_history(item['result_id'])==item['review_history']
    labels=project.load_array(result['arrays']['labels'])
    expected_labels=np.zeros((64,96),np.uint32); expected_labels[8:22,10:29]=3; expected_labels[36:55,55:82]=11
    np.testing.assert_array_equal(labels,expected_labels); assert np.unique(labels).tolist()==[0,3,11]
    foreground=labels!=0; adjacent=np.zeros_like(foreground)
    adjacent[1:]|=foreground[:-1]; adjacent[:-1]|=foreground[1:]
    adjacent[:,1:]|=foreground[:,:-1]; adjacent[:,:-1]|=foreground[:,1:]
    boundary=(labels==0)&adjacent  # Separated rectangles: outer, four-connected background ring.
    record=images[item['result_id']]
    assert record['image_name']==f"/root/{item['group']}/Preview_12.tif"
    assert record['cell_count']==2 and record['review_status']=='pending' and record['review'] is None
    assert record['source_sha256']==item['source_sha256'] and record['revision_hash']==item['revision_hash']
    outline=record['outline']; expected_path=f"outlines/{item['group']}/Preview_12.tif.outlines.png"
    assert outline['path']==expected_path
    png=target/expected_path; assert hashlib.sha256(png.read_bytes()).hexdigest()==outline['sha256']
    assert png.stat().st_size==outline['size_bytes']
    with Image.open(png) as image:
        assert image.size==(96,64) and image.mode=='RGB'
        actual=np.asarray(image); np.testing.assert_array_equal(actual[~boundary],raw[~boundary])
        assert np.all(actual[boundary]==[41,245,201])
        np.testing.assert_array_equal(np.all(actual==[41,245,201],axis=-1),boundary)
        context=json.loads(image.info['Loci review provenance'])
        assert context['review_status']=='pending' and context['source_id']==item['source_id']
        assert context['source_sha256']==item['source_sha256'] and context['revision_hash']==item['revision_hash']
        assert context['profile']['id']=='synthetic-qa'
    checks.append({'image_name':record['image_name'],'cell_count':2,'shape_yx':[64,96],
        'boundary_pixels':int(boundary.sum()),'nonboundary_pixels_exact':True,'boundary_mask_exact':True,
        'source_unchanged':True,'review_history_unchanged':True,'png_sha256':outline['sha256']})
expected_files={'manifest.json','counts.csv',*(r['outline']['path'] for r in manifest['images'])}
assert {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()}==expected_files
print(json.dumps({'manifest_sha256':hashlib.sha256(manifest_bytes).hexdigest(),'counts_sha256':count['sha256'],'rows':rows,'images':checks}))
`;

try {
  assert.equal(await git("status", "--porcelain", "--", "desktop/src", "engine/src"), "",
    "Commit runtime sources before qualifying their packaged candidate");
  report.source = { commit: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
    desktop_tree: await git("rev-parse", "HEAD:desktop/src"), engine_tree: await git("rev-parse", "HEAD:engine/src"),
    harness_sha256: await sha(import.meta.filename),
    helper_sha256: await sha(path.join(import.meta.dirname, "workbench-qa-helpers.mjs")) };
  if (process.env.LOCI_QA_SOURCE_COMMIT) assert.equal(report.source.commit, process.env.LOCI_QA_SOURCE_COMMIT);
  report.build = await buildIdentity(); report.app = bundle;
  const fixture = JSON.parse((await run(python, ["-c", fixtureProgram, output], pythonOptions)).stdout);
  await fs.writeFile(path.join(output, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
  report.fixture = { schema: fixture.schema, sha256: await sha(path.join(output, "fixture.json")),
    images: fixture.items.map(({ group, source_sha256, source_id, result_id, revision_hash, label_ids, shape_yx }) =>
      ({ group, source_sha256, source_id, result_id, revision_hash, label_ids, shape_yx })) };
  const ids = fixture.items.map(item => item.result_id);
  await launch();
  await fileMenuAction(page, "Open study");
  const before = await until(snapshot, value => value?.sources.length === 2 && value.results.length === 2, "synthetic study opened");
  assert.deepEqual(before.sources.map(item => item.name), ["Preview_12.tif", "Preview_12.tif"]);
  assert.ok(before.results.every(item => item.object_count === 2 && !item.review));
  const histories = await reviewHistories(ids);
  assert.ok(histories.every(item => item.total_events === 0));
  await shot("01-synthetic-study");
  await fileMenuAction(page, "Save as study…");
  await until(() => fs.stat(path.join(saved, "study.sqlite3")).catch(error => { if (error.code === "ENOENT") return null; throw error; }), value => value?.isFile(), "internal SaveAs published");
  await until(() => page.locator(".session-save-state").textContent(), text => text === "Saved locally", "SaveAs completed");
  const afterSave = await snapshot();
  assert.deepEqual(resultRecords(afterSave), resultRecords(before));
  assert.deepEqual(await reviewHistories(ids), histories);
  await reviewedExportBlocked(fixture.items);
  await selectWorkbenchTool(page, "Study");
  for (const id of ids) await page.getByRole("checkbox", { name: `Compare ${id}`, exact: true }).check();
  assert.equal(await page.getByRole("button", { name: "Export selected reviewed results", exact: true }).isEnabled(), false);
  await page.getByLabel("Review package name", { exact: true }).fill(rootLabel);
  await shot("02-pending-export-selection");
  await page.getByRole("button", { name: "Export review package", exact: true }).click();
  await until(() => page.getByRole("status").allTextContents(), texts => texts.some(text => text.includes("Saved 2 images and counts.csv in root.")), "review package UI receipt");
  report.checks.artifacts = JSON.parse((await run(python, ["-c", auditProgram, output], pythonOptions)).stdout);
  assert.deepEqual(resultRecords(await snapshot()), resultRecords(afterSave));
  assert.deepEqual(await reviewHistories(ids), histories);
  assert.equal(await page.getByRole("button", { name: "Export selected reviewed results", exact: true }).isEnabled(), false);
  await shot("03-provisional-package-saved");
  report.checks.internal_save_as = { absent_destination: saved, cold_reopen: false };
  if (process.env.LOCI_QA_EXFAT_PARENT) {
    const parent = process.env.LOCI_QA_EXFAT_PARENT;
    assert.ok(path.isAbsolute(parent), "LOCI_QA_EXFAT_PARENT must be an absolute explicitly authorized directory");
    const canonical = await fs.realpath(parent);
    const ownDirectory = await fs.mkdtemp(path.join(canonical, "loci-review-package-synthetic-"));
    saveDestination = path.join(ownDirectory, "rejected.loci-study"); await pickers();
    await fileMenuAction(page, "Save as study…");
    const text = await until(() => page.locator('.research-alert[role="alert"]').allTextContents(), texts => texts.some(text => /atomic study saving/.test(text)), "unsupported-volume error", true);
    assert.match(text.join("\n"), /APFS/);
    assert.deepEqual(await fs.readdir(ownDirectory), [], "Failed SaveAs must clean only its synthetic staging tree");
    assert.deepEqual(resultRecords(await snapshot()), resultRecords(afterSave));
    assert.deepEqual(await reviewHistories(ids), histories);
    report.checks.exfat_rejection = { directory: ownDirectory, error: text, cleanup_exact: true };
    await shot("04-unsupported-volume");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  await close(); openStudy = saved; saveDestination = saved; await launch();
  await fileMenuAction(page, "Open study");
  const reopened = await until(snapshot, value => value?.results.length === 2, "cold saved study reopened");
  assert.deepEqual(reopened.sources, afterSave.sources);
  assert.deepEqual(resultRecords(reopened), resultRecords(afterSave));
  assert.deepEqual(await reviewHistories(ids), histories);
  await reviewedExportBlocked(fixture.items);
  report.checks.cold_artifacts = JSON.parse((await run(python, ["-c", auditProgram, output], pythonOptions)).stdout);
  assert.deepEqual(report.checks.cold_artifacts, report.checks.artifacts);
  report.checks.internal_save_as.cold_reopen = true;
  report.checks.pending_review_unchanged = true;
  report.checks.reviewed_export_still_blocked = true;
  await shot("05-cold-reopened-pending");
  assert.deepEqual(await buildIdentity(), report.build, "Candidate bundle changed during qualification");
  assert.equal(await git("rev-parse", "HEAD"), report.source.commit, "Source commit changed during qualification");
  assert.equal(await git("status", "--porcelain", "--", "desktop/src", "engine/src"), "", "Runtime sources changed during qualification");
  assert.equal(await sha(import.meta.filename), report.source.harness_sha256, "Harness changed during qualification");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requests, [], "Synthetic local workflow must issue no HTTP requests");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.stack ?? String(error);
  if (page) await shot("failure").catch(() => undefined);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  try { await close(); } catch (error) { report.errors.push({ kind: "close", message: String(error) }); report.status = "failed"; }
  await fs.writeFile(receiptPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, receipt: receiptPath }));
  if (report.status !== "passed") process.exitCode = 1;
}
