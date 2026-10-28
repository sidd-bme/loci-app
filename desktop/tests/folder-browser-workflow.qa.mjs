/** Synthetic packaged folder browser -> Save As -> cold reopen journey.
 * Only the designated build owner runs this harness. Set absolute
 * LOCI_PACKAGED_APP and LOCI_QA_OUTPUT_ROOT (existing internal-volume directory),
 * and optionally LOCI_QA_REFERENCE_PYTHON / LOCI_QA_SOURCE_COMMIT.
 * Authoring / syntax checks do not launch Loci. No inference, HPC, protected
 * sources, network, installations, or environment synchronisation are needed.
 * Native picker overrides select only newly authored synthetic fixtures. After
 * launch, all mutations use UI; renderer APIs and SQLite are read-only oracles.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
const requestedOutput = process.env.LOCI_QA_OUTPUT_ROOT;
assert.equal(process.platform, "darwin", "Qualifies a real packaged macOS journey");
assert.ok(bundle && path.isAbsolute(bundle), "Set absolute LOCI_PACKAGED_APP");
assert.ok(requestedOutput && path.isAbsolute(requestedOutput), "Set absolute LOCI_QA_OUTPUT_ROOT");
const qaRoot = await fs.realpath(requestedOutput);
assert.equal((await fs.stat(qaRoot)).dev, (await fs.stat(os.homedir())).dev,
  "Synthetic app data and outputs must use the internal home volume");
const output = await fs.mkdtemp(path.join(qaRoot, "folder-browser-workflow-"));
const userData = path.join(output, "user-data");
const original = path.join(output, "synthetic-original.loci-study");
const saved = path.join(output, "synthetic-saved.loci-study");
const python = process.env.LOCI_QA_REFERENCE_PYTHON ?? path.join(root, "engine/.venv/bin/python");
const executablePath = path.join(bundle, "Contents/MacOS/Loci");
const report = { schema: "loci.folder-browser-workflow-qa/v1", status: "running",
  started_at: new Date().toISOString(), checks: {}, errors: [], requests: [], screenshots: [],
  limits: ["Strictly synthetic RGB pixels and authored labels; no biological or clinical validation",
    "Does not run analysis, remote compute, or protected laboratory data",
    "Portable-study trust validation belongs to engine regressions"] };
let app, page, openStudy = original, fixture, baseline, importChoice = { kind: "cancel", paths: [] };
const displayPaths = new Map();
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
  asar_sha256: await sha(path.join(bundle, "Contents/Resources/app.asar")),
  worker_sha256: await sha(path.join(bundle, "Contents/Resources/loci-engine/loci-engine")) });
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const sorted = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
const sourceRecords = value => sorted(value.sources);
const resultRecords = value => sorted(value.results);
const rail = () => page.locator(".research-sources");
const leaf = id => rail().locator(`[data-source-id="${id}"]`);
const activeId = () => rail().locator('[data-source-id][aria-current="true"]').getAttribute("data-source-id");
const tree = () => rail().getByRole("tree");
const search = () => rail().getByRole("searchbox", { name: "Search images and folders", exact: true });
async function until(read, accept, label) {
  const deadline = Date.now() + 60_000;
  let value;
  while (Date.now() < deadline) {
    const alerts = page.locator('.research-alert[role="alert"]');
    if (await alerts.count()) throw new Error(`${label}: ${await alerts.first().textContent()}`);
    value = await read();
    if (accept(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(value)}`);
}
function safeSnapshot(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [output, os.homedir(), "/Users/", "/Volumes/", "private-do-not-disclose"])
    assert.equal(text.includes(forbidden), false, `Renderer snapshot discloses ${forbidden}`);
  const inspect = item => {
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(key.startsWith("private_"), false, `Renderer snapshot discloses ${key}`);
      inspect(nested);
    }
  };
  inspect(value);
  for (const source of value.sources) {
    const location = source.browser_location;
    assert.ok(location && typeof location.relative_path === "string", "All synthetic paths have safe context");
    assert.equal(path.posix.isAbsolute(location.relative_path), false);
    assert.ok(location.relative_path.split("/").every(part => part && part !== "." && part !== ".."));
  }
}
async function histories() {
  return page.evaluate(async ids => {
    const records = [];
    for (const result_id of ids) records.push(await window.lociResearch.execute("review_history", { result_id }));
    return records;
  }, fixture.legacy.map(item => item.result_id));
}
async function unchanged(label, expected = baseline) {
  const value = await snapshot(); safeSnapshot(value);
  assert.deepEqual(sourceRecords(value), sourceRecords(expected), `${label}: source scientific records changed`);
  assert.deepEqual(resultRecords(value), resultRecords(expected), `${label}: results changed`);
  assert.deepEqual(value.jobs, expected.jobs, `${label}: browsing or batch selection created an analysis job`);
  assert.deepEqual(await histories(), report.baseline_histories, `${label}: review state/history changed`);
  return value;
}
async function pickers() {
  await app.evaluate(({ dialog }, values) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title !== "Save research study as") throw new Error(`Unexpected save dialog: ${options?.title}`);
      return { canceled: false, filePath: values.saved };
    };
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Open research study") return { canceled: false, filePaths: [values.openStudy] };
      if (options?.title === "Select a folder of research images") {
        if (values.choice.kind === "cancel") return { canceled: true, filePaths: [] };
        if (values.choice.kind !== "folder") throw new Error("Unexpected folder picker");
        return { canceled: false, filePaths: values.choice.paths };
      }
      if (options?.title === "Add microscopy or medical images" && values.choice.kind === "files")
        return { canceled: false, filePaths: values.choice.paths };
      throw new Error(`Unexpected open dialog: ${options?.title}`);
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { openStudy, saved, choice: importChoice });
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
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000);
    window.show(); window.focus(); app.focus({ steal: true });
  });
  await pickers();
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit()); await closed; app = undefined;
}
async function expandAll() {
  // Visible native tree disclosures only; no DOM or renderer-state mutation.
  while (await tree().locator('[role="treeitem"][aria-expanded="false"]').count()) {
    const folder = await tree().locator('[role="treeitem"][aria-expanded="false"]').first().elementHandle();
    assert.ok(folder);
    await folder.focus(); await folder.press("ArrowRight");
    assert.equal(await folder.getAttribute("aria-expanded"), "true");
  }
}
async function activate(id) {
  await search().fill(""); await expandAll(); await leaf(id).click();
  await until(activeId, value => value === id, `activate exact source ${id}`);
}
async function importSources(kind, paths, expectedCount) {
  importChoice = { kind, paths }; await pickers();
  if (kind === "folder") await fileMenuAction(page, "Open folder");
  else await page.getByRole("button", { name: "Add images", exact: true }).click();
  const value = await until(snapshot, value => value?.sources.length === expectedCount, `${kind} UI import`);
  safeSnapshot(value); return value;
}
async function shot(name) {
  const relative = `screenshots/${name}.png`;
  await page.screenshot({ path: path.join(output, relative) });
  report.screenshots.push({ path: relative, sha256: await sha(path.join(output, relative)) });
}
async function geometry(label) {
  const value = await rail().evaluate(element => {
    const box = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll('[role="treeitem"], .research-source-item')]
      .filter(row => row.getClientRects().length);
    return { viewport: { width: innerWidth, height: innerHeight }, document_width: document.documentElement.scrollWidth,
      rail: { left: box.left, right: box.right, width: box.width },
      rows: rows.map(row => {
        const r = row.getBoundingClientRect();
        return { source_id: row.getAttribute("data-source-id"), left: r.left, right: r.right, width: r.width,
          scroll_width: row.scrollWidth, client_width: row.clientWidth,
          controls: [...row.querySelectorAll("button, input, .source-tree-name, .research-source-name")].map(control => {
            const c = control.getBoundingClientRect(); return { left: c.left, right: c.right, width: c.width };
          }) };
      }) };
  });
  assert.ok(value.document_width <= value.viewport.width + 1, `${label}: document horizontal overflow`);
  assert.ok(value.rows.length > 0, `${label}: no visible source rows`);
  for (const row of value.rows) {
    assert.ok(row.width > 0 && row.left >= value.rail.left - 1 && row.right <= value.rail.right + 1,
      `${label}: row escapes source rail ${JSON.stringify(row)}`);
    assert.ok(row.scroll_width <= row.client_width + 1, `${label}: text/control content overflows source row`);
    for (const control of row.controls)
      assert.ok(control.left >= row.left - 1 && control.right <= row.right + 1,
        `${label}: text/control escapes row`);
  }
  report.checks.geometry ??= {}; report.checks.geometry[label] = value;
}
async function appearance(width, height, theme, size) {
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setContentSize(bounds.width, bounds.height), { width, height });
  await page.waitForFunction(bounds => innerWidth === bounds.width && innerHeight === bounds.height, { width, height });
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("combobox", { name: "Application theme" }).selectOption(theme);
  await dialog.getByRole("radio", { name: new RegExp(`^${size === "large" ? "Large" : "Standard"}`) }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForFunction(([theme, size]) => document.documentElement.dataset.theme === theme &&
    document.documentElement.dataset.textSize === size, [theme, size]);
}

// Prepared before launch using the supported engine API. No model or algorithm
// creates these labels: two deliberately authored, separated rectangles.
const fixtureProgram = String.raw`
import hashlib,json,sqlite3,sys
from pathlib import Path
import numpy as np,tifffile
from loci_engine.quantitative import measure_objects
from loci_engine.research_project import ResearchProject
from loci_engine.workbench import Workbench
root=Path(sys.argv[1]); wb=Workbench(ResearchProject.create(root/'synthetic-original.loci-study','Synthetic folder browser QA'))
legacy=[]; files=[]; yy,xx=np.indices((48,72))
def make(location,index):
    pixels=np.stack(((xx*2+yy+index*13)%191,(xx+yy*3+index*19)%191,(xx*5+yy*2+index*29)%191),axis=-1).astype(np.uint8)
    location.parent.mkdir(parents=True,exist_ok=True); tifffile.imwrite(location,pixels,photometric='rgb',metadata=None)
    files.append(dict(path=str(location),sha256=hashlib.sha256(location.read_bytes()).hexdigest(),index=index))
    return pixels
try:
    for index,group in enumerate(('Control','Treatment/Day 2')):
        relative=group+'/Preview_01.tif'; location=root/'private-do-not-disclose'/'legacy'/relative
        pixels=make(location,index); source=wb.import_native(str(location),relative_path=relative)
        selection=dict(x=0,y=0,width=72,height=48,t=0,c=0,z=0,level=0)
        _,geometry,resolved=wb.load_scalar(source['id'],selection,allow_rgb=True); assert resolved==selection
        labels=np.zeros((48,72),np.uint32); labels[5:16,7:22]=3; labels[29:43,44:65]=11
        result=wb.project.save_result(source_id=source['id'],kind='segmentation',
            arrays={'image':pixels.mean(axis=-1)/255,'labels':labels},
            provenance={'synthetic_fixture':True,'selection':selection,'geometry':geometry.to_dict(),
                'segmentation':{'method':'synthetic-authored-rectangles','count':2},
                'measurements':measure_objects(labels,geometry),'runtime':{'engine':'synthetic-fixture-author'},
                'profile':{'id':'synthetic-qa','version':'1'},'model':{'rights':{'commercial_use':'unknown'}}})
        stored=wb.project.source(source['id']); assert 'browser_location' not in stored
        assert wb.project.review_state(result['id']) is None and wb.project.review_history(result['id'])==[]
        legacy.append(dict(source_id=source['id'],relative_path=relative,source_record=stored,result_id=result['id'],result=result))
    folders=[]
    for number in (1,2):
        folder=root/'private-do-not-disclose'/('import-'+str(number))/'Dataset'; folders.append(str(folder))
        make(folder/'Control'/'Preview_01.tif',number*10)
        make(folder/'Treatment'/'Day 2'/'深い階層'/'Nested segment with spaces'/('Long microscopy image label '+('abcdef-'*12)+'Ω.tif'),number*10+1)
    loose=root/'private-do-not-disclose'/'loose'/'Loose image.tif'; make(loose,40)
    with sqlite3.connect(wb.project.database) as db:
        results=[list(row) for row in db.execute('SELECT id,record FROM results ORDER BY id')]
        reviews=[list(row) for row in db.execute("SELECT key,value FROM metadata WHERE key LIKE 'review:%' OR key LIKE 'review-event:%' ORDER BY key")]
    print(json.dumps(dict(schema='loci.synthetic-folder-fixture/v1',legacy=legacy,files=files,folders=folders,loose=str(loose),
        original_results=results,original_reviews=reviews)))
finally:
    wb.close()
`;

// Uses SQLite mode=ro and independent NumPy rectangle / RGB formula oracles.
// Reading a completed study never calls engine mutators or folder-display code.
const auditProgram = String.raw`
import hashlib,json,sqlite3,sys
from pathlib import Path
import numpy as np,tifffile
root=Path(sys.argv[1]); study=Path(sys.argv[2]); fixture=json.loads((root/'fixture.json').read_text())
connection=sqlite3.connect(study.joinpath('study.sqlite3').as_uri()+'?mode=ro',uri=True)
try:
    sources={key:json.loads(record) for key,record in connection.execute('SELECT id,record FROM sources')}
    results=[list(row) for row in connection.execute('SELECT id,record FROM results ORDER BY id')]
    reviews=[list(row) for row in connection.execute("SELECT key,value FROM metadata WHERE key LIKE 'review:%' OR key LIKE 'review-event:%' ORDER BY key")]
finally:
    connection.close()
assert results==fixture['original_results']; assert reviews==fixture['original_reviews']==[]
assert len(sources) in (2,7)
yy,xx=np.indices((48,72)); checks=[]
for item in fixture['files']:
    source=Path(item['path']); assert hashlib.sha256(source.read_bytes()).hexdigest()==item['sha256']
    index=item['index']; raw=tifffile.imread(source)
    expected=np.stack(((xx*2+yy+index*13)%191,(xx+yy*3+index*19)%191,(xx*5+yy*2+index*29)%191),axis=-1).astype(np.uint8)
    np.testing.assert_array_equal(raw,expected)
for item in fixture['legacy']:
    assert sources[item['source_id']]==item['source_record'], 'Legacy source record was rewritten by browsing'
    result=item['result']; expected=np.zeros((48,72),np.uint32); expected[5:16,7:22]=3; expected[29:43,44:65]=11
    for name,descriptor in result['arrays'].items():
        file=study/'artifacts'/(descriptor['sha256']+'.npy')
        assert hashlib.sha256(file.read_bytes()).hexdigest()==descriptor['sha256']
        actual=np.load(file,allow_pickle=False)
        if name=='labels': np.testing.assert_array_equal(actual,expected)
        elif name=='image':
            index=next(file['index'] for file in fixture['files'] if file['path']==item['source_record']['private_path'])
            pixels=np.stack(((xx*2+yy+index*13)%191,(xx+yy*3+index*19)%191,(xx*5+yy*2+index*29)%191),axis=-1).astype(np.uint8)
            np.testing.assert_array_equal(actual,pixels.mean(axis=-1)/255)
    assert np.unique(expected).tolist()==[0,3,11]
    checks.append(dict(source_id=item['source_id'],result_id=result['id'],revision_hash=result['revision_hash'],label_ids=[3,11]))
for source in sources.values():
    assert Path(source['private_path']).is_file()
    assert hashlib.sha256(Path(source['private_path']).read_bytes()).hexdigest()==source['sha256']
print(json.dumps(dict(source_count=len(sources),result_count=len(results),source_hashes={key:value['sha256'] for key,value in sorted(sources.items())},
    source_records_sha256=hashlib.sha256(json.dumps(sources,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(),
    results_exact=True,reviews_exact=True,legacy_source_records_exact=True,arrays=checks)))
`;

try {
  assert.equal(await git("status", "--porcelain", "--", "desktop/src", "engine/src"), "",
    "Commit runtime sources before qualifying a packaged candidate");
  report.source = { commit: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
    desktop_tree: await git("rev-parse", "HEAD:desktop/src"), engine_tree: await git("rev-parse", "HEAD:engine/src"),
    harness_sha256: await sha(import.meta.filename), helper_sha256: await sha(path.join(import.meta.dirname, "workbench-qa-helpers.mjs")) };
  if (process.env.LOCI_QA_SOURCE_COMMIT) assert.equal(report.source.commit, process.env.LOCI_QA_SOURCE_COMMIT);
  report.app = bundle; report.build = await buildIdentity();
  fixture = JSON.parse((await run(python, ["-c", fixtureProgram, output], pythonOptions)).stdout);
  await fs.writeFile(path.join(output, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
  report.fixture_sha256 = await sha(path.join(output, "fixture.json"));
  await launch(); await fileMenuAction(page, "Open study");
  const initial = await until(snapshot, value => value?.sources.length === 2 && value.results.length === 2, "legacy study opened");
  safeSnapshot(initial);
  for (const item of fixture.legacy)
    assert.deepEqual(initial.sources.find(source => source.id === item.source_id).browser_location,
      { relative_path: item.relative_path, root: null });
  report.baseline_histories = await histories();
  assert.ok(report.baseline_histories.every(item => item.total_events === 0));
  assert.ok(initial.results.every(item => item.object_count === 2 && !item.review));
  await fileMenuAction(page, "Open folder"); // Cancellation must not change the open study.
  await unchanged("cancel folder picker", initial);
  await importSources("folder", [fixture.folders[0]], 4);
  await importSources("folder", [fixture.folders[1]], 6);
  baseline = await importSources("files", [fixture.loose], 7);
  assert.equal(new Set(baseline.sources.map(item => item.id)).size, 7);
  const imported = baseline.sources.filter(item => !fixture.legacy.some(legacy => legacy.source_id === item.id));
  const roots = [...new Map(imported.filter(item => item.browser_location.root)
    .map(item => [item.browser_location.root.id, item.browser_location.root])).values()];
  assert.equal(roots.length, 2); assert.ok(roots.every(item => item.name === "Dataset"));
  const duplicates = imported.filter(item => item.browser_location.relative_path === "Control/Preview_01.tif");
  assert.equal(duplicates.length, 2); assert.notEqual(duplicates[0].sha256, duplicates[1].sha256);
  assert.notEqual(duplicates[0].browser_location.root.id, duplicates[1].browser_location.root.id);
  const loose = imported.find(item => item.name === "Loose image.tif"); assert.ok(loose);
  assert.equal(loose.browser_location.root, null);
  report.checks.imported_artifacts = JSON.parse((await run(python, ["-c", auditProgram, output, original], pythonOptions)).stdout);
  assert.equal(report.checks.imported_artifacts.source_count, 7);
  await expandAll();
  for (const source of baseline.sources) {
    const displayPath = await leaf(source.id).getAttribute("aria-description");
    assert.ok(displayPath?.endsWith(source.browser_location.relative_path), "Accessible image context retains the source-relative path");
    displayPaths.set(source.id, displayPath);
  }
  const groups = await tree().locator('[role="treeitem"][aria-expanded="true"]').evaluateAll(nodes => nodes.map(node => {
    const group = document.getElementById(node.getAttribute("aria-owns"));
    return Boolean(group && group.getAttribute("role") === "group" && group.querySelector('[role="treeitem"]'));
  }));
  assert.ok(groups.length && groups.every(Boolean), "Expanded folders own their nested accessibility groups");
  const beforeNavigation = await activeId();
  const first = tree().getByRole("treeitem").first(); await first.focus();
  await page.keyboard.press("End");
  const focusedLast = await page.evaluate(() => document.activeElement?.getAttribute("data-source-id"));
  assert.equal(await activeId(), beforeNavigation, "Tree keyboard focus must not activate an image");
  assert.ok(focusedLast, "Last visible tree item is an image leaf");
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
  assert.equal(await activeId(), beforeNavigation, "Arrow/Home navigation must not activate an image");
  await page.keyboard.type("Loose");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-source-id")), loose.id,
    "Tree typeahead focuses the matching loose image");
  assert.equal(await activeId(), beforeNavigation, "Typeahead must not activate an image");
  await leaf(duplicates[0].id).focus();
  const selectedBeforeSpace = await leaf(duplicates[0].id).getAttribute("aria-selected");
  await page.keyboard.press("Space");
  assert.notEqual(await leaf(duplicates[0].id).getAttribute("aria-selected"), selectedBeforeSpace, "Space toggles exact focused selection");
  assert.equal(await activeId(), beforeNavigation, "Space selection does not activate an image");
  await page.keyboard.press("Enter");
  assert.equal(await activeId(), duplicates[0].id, "Enter explicitly activates the focused exact ID");
  assert.equal(await page.getByLabel("Current image path", { exact: true }).textContent(), displayPaths.get(duplicates[0].id));
  await page.locator(".source-display").getByRole("button", { name: "Reset display", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Current image path", { exact: true }).isVisible(), true,
    "Folder breadcrumbs remain visible beside the display inspector");
  const parent = await leaf(duplicates[0].id).getAttribute("aria-level"); assert.ok(Number(parent) > 1);
  await page.keyboard.press("ArrowLeft");
  const folder = tree().locator('[role="treeitem"]:focus');
  assert.equal(await folder.getAttribute("aria-expanded"), "true", "Left from image focuses its parent folder");
  await folder.press("ArrowLeft"); assert.equal(await folder.getAttribute("aria-expanded"), "false");
  await folder.press("ArrowRight"); assert.equal(await folder.getAttribute("aria-expanded"), "true");
  await unchanged("tree keyboard and disclosures");

  await folder.press("ArrowLeft");
  const expansionState = () => tree().locator('[data-folder-id]').evaluateAll(rows =>
    rows.map(row => [row.dataset.folderId, row.getAttribute("aria-expanded")]));
  const beforeSearch = await expansionState();
  await search().fill("Preview_01.tif");
  assert.equal(await rail().locator("[data-source-id]").count(), 4, "All four duplicate leaves retain distinct IDs");
  assert.ok(await tree().getByRole("treeitem").count() > 4, "Search retains matching leaves' ancestors");
  await search().fill("Treatment/Day 2");
  assert.equal(await rail().locator("[data-source-id]").count(), 3, "Search matches relative folder context");
  await search().fill("no-such-synthetic-image-XYZ");
  assert.equal(await rail().locator("[data-source-id]").count(), 0);
  await rail().getByRole("button", { name: "Clear image search", exact: true }).click();
  assert.deepEqual(await expansionState(), beforeSearch, "Clearing search restores prior expansion state");
  await expandAll();
  // Explicit reveal restores a hidden active source and focuses its exact leaf.
  await activate(duplicates[0].id); await leaf(duplicates[0].id).press("ArrowLeft");
  await tree().locator('[role="treeitem"]:focus').press("ArrowLeft");
  assert.equal(await leaf(duplicates[0].id).count(), 0);
  await rail().getByRole("button", { name: "Reveal current image", exact: true }).click();
  await leaf(duplicates[0].id).waitFor({ state: "visible" });
  await until(() => page.evaluate(() => document.activeElement?.getAttribute("data-source-id")),
    value => value === duplicates[0].id, "current image reveal focuses exact source");
  await rail().getByRole("button", { name: "Flat list", exact: true }).click();
  await leaf(duplicates[1].id).click();
  await rail().getByRole("button", { name: "Folder tree", exact: true }).click();
  await leaf(duplicates[1].id).waitFor({ state: "visible" });
  assert.equal(await activeId(), duplicates[1].id, "Active source reveals ancestors on entering folder mode");
  await expandAll(); await leaf(duplicates[0].id).click();
  await leaf(duplicates[1].id).click({ modifiers: ["Meta"] });
  assert.deepEqual((await rail().locator('[data-source-id][aria-selected="true"]').evaluateAll(rows => rows.map(row => row.dataset.sourceId))).sort(),
    duplicates.map(item => item.id).sort(), "Duplicate names never substitute source identity");

  await selectWorkbenchTool(page, "Study");
  const batch = page.getByRole("group", { name: "Batch images", exact: true });
  const batchCheckbox = id => batch.getByRole("checkbox", { name: `Include ${displayPaths.get(id)} in batch`, exact: true });
  const checkedBatch = async () => {
    const ids = [];
    for (const source of baseline.sources) if (await batchCheckbox(source.id).isChecked()) ids.push(source.id);
    return ids.sort();
  };
  assert.deepEqual(await checkedBatch(), [], "Study scope starts empty despite sidebar multi-selection");
  await batch.getByRole("button", { name: "Select all batch images", exact: true }).click();
  assert.deepEqual(await checkedBatch(), baseline.sources.map(item => item.id).sort());
  await batch.getByRole("button", { name: "Clear batch image selection", exact: true }).click();
  const rootDisplayName = displayPaths.get(duplicates[0].id).split("/")[0];
  const rootGroupCheckbox = batch.getByRole("checkbox", { name: `Include folder ${rootDisplayName} in batch`, exact: true });
  await rootGroupCheckbox.check();
  const rootId = duplicates[0].browser_location.root.id;
  assert.deepEqual(await checkedBatch(), imported.filter(item => item.browser_location.root?.id === rootId).map(item => item.id).sort());
  await activate(loose.id);
  assert.deepEqual(await checkedBatch(), imported.filter(item => item.browser_location.root?.id === rootId).map(item => item.id).sort(),
    "Sidebar activation never changes Study batch scope");
  await rootGroupCheckbox.uncheck(); assert.deepEqual(await checkedBatch(), []);
  await batchCheckbox(duplicates[1].id).check();
  assert.deepEqual(await checkedBatch(), [duplicates[1].id]);
  await unchanged("folder batch scope without launching analysis");
  await geometry("batch-folders"); await shot("batch-folders");

  // Close/undo changes workspace visibility, preserving all scientific records.
  await activate(loose.id); await page.getByRole("button", { name: "Remove selected images", exact: true }).click();
  const closed = await until(snapshot, value => value?.sources.length === 6, "source closed");
  assert.equal(closed.workspace.closed_sources.find(item => item.id === loose.id)?.sha256, loose.sha256);
  assert.deepEqual(resultRecords(closed), resultRecords(baseline));
  await rail().getByRole("button", { name: "Undo", exact: true }).click();
  await until(snapshot, value => value?.sources.length === 7, "close undone"); await unchanged("close undo");
  await rail().getByRole("button", { name: "Flat list", exact: true }).click();
  const orderBefore = (await snapshot()).sources.map(item => item.id);
  await leaf(orderBefore[0]).focus(); await leaf(orderBefore[0]).press("Alt+ArrowDown");
  const expectedOrder = [orderBefore[1], orderBefore[0], ...orderBefore.slice(2)];
  await until(snapshot, value => JSON.stringify(value.sources.map(item => item.id)) === JSON.stringify(expectedOrder), "keyboard flat-list order persisted");
  await unchanged("flat list ordering");
  report.checks.manual_source_order = expectedOrder;
  await rail().getByRole("button", { name: "Folder tree", exact: true }).click(); await expandAll();
  await fileMenuAction(page, "Save as study…");
  await until(() => fs.stat(path.join(saved, "study.sqlite3")).catch(error => { if (error.code === "ENOENT") return null; throw error; }), value => value?.isFile(), "Save As published");
  await until(() => page.locator(".session-save-state").textContent(), text => text === "Saved locally", "Save As completed");
  const afterSave = await unchanged("Save As");
  report.checks.artifacts = JSON.parse((await run(python, ["-c", auditProgram, output, saved], pythonOptions)).stdout);
  assert.deepEqual(report.checks.artifacts, report.checks.imported_artifacts,
    "Browsing, workspace actions and Save As preserve every stored source/result/review record and array");

  // One batched native screenshot pass, with real settings and window controls.
  await selectWorkbenchTool(page, "Display"); await activate(duplicates[1].id); await expandAll();
  for (const [width, height, theme, size] of [[1680, 900, "graphite", "standard"], [1280, 800, "paper", "standard"], [1280, 800, "paper", "large"], [1280, 800, "fiji", "standard"]]) {
    await appearance(width, height, theme, size);
    const name = `${width}x${height}-${theme}-${size}`;
    await geometry(name); await shot(name);
  }
  await leaf(duplicates[1].id).focus(); await page.keyboard.press("ArrowUp");
  await geometry("keyboard-focus"); await shot("keyboard-focus");
  await search().fill("Preview_01.tif"); await geometry("duplicate-search"); await shot("duplicate-search");
  await search().fill("");
  await close(); openStudy = saved; await launch(); await fileMenuAction(page, "Open study");
  await until(snapshot, value => value?.sources.length === 7 && value.results.length === 2, "cold reopen");
  const reopened = await unchanged("cold reopen", afterSave);
  assert.deepEqual(reopened.sources.map(item => item.id), expectedOrder);
  report.checks.cold_artifacts = JSON.parse((await run(python, ["-c", auditProgram, output, saved], pythonOptions)).stdout);
  assert.deepEqual(report.checks.cold_artifacts, report.checks.artifacts);
  report.checks.folder_identity = { legacy_unknown_roots: true, distinct_same_named_roots: roots,
    duplicate_sources: duplicates.map(({ id, sha256, browser_location }) => ({ id, sha256, browser_location })) };
  report.checks.ui = { keyboard_focus_separate_from_activation: true, collapse_expand: true,
    search_ancestors_and_no_results: true, active_reveal: true, exact_id_selection: true,
    batch_scope_independent: true, cancellation: true, close_undo: true, flat_keyboard_order: true,
    save_as_cold_reopen: true };
  assert.deepEqual(await buildIdentity(), report.build, "Candidate changed during qualification");
  assert.equal(await git("rev-parse", "HEAD"), report.source.commit);
  assert.equal(await git("status", "--porcelain", "--", "desktop/src", "engine/src"), "");
  assert.equal(await sha(import.meta.filename), report.source.harness_sha256);
  assert.equal(await sha(path.join(import.meta.dirname, "workbench-qa-helpers.mjs")), report.source.helper_sha256);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.requests, [], "Local synthetic workflow made HTTP requests");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.stack ?? String(error);
  if (page) await shot("failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  try { await close(); } catch (error) { report.errors.push({ kind: "close", message: String(error) }); report.status = "failed"; }
  const receipt = path.join(output, "receipt.json");
  await fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, receipt }));
  if (report.status !== "passed") process.exitCode = 1;
}
