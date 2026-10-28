/** Packaged activation acceptance. Mutations use ordinary controls and recorded picker substitutions.
 * LOCI_PACKAGED_APP=/.../Loci.app LOCI_QA_PYTHON=/.../python LOCI_QA_SOURCE_COMMIT=<40-char SHA>
 * LOCI_QA_OUTPUT_ROOT=/.../evidence node tests/researcher-activation.qa.mjs
 * No fixture downloads, provisioning, DOM/React state injection or database edits. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool, setSelectionField, waitForSnapshot } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
const bundle = process.env.LOCI_PACKAGED_APP, python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin', 'Supported packaged macOS journey');
for (const [name, value] of Object.entries({ LOCI_PACKAGED_APP: bundle, LOCI_QA_PYTHON: python }))
  assert.ok(value && path.isAbsolute(value), `Set explicit absolute ${name}`);
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'Pin LOCI_QA_SOURCE_COMMIT');
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repo, '.loci/evidence/qa/researcher-activation'));
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'run-')), study = path.join(output, 'activation.loci-study');
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const helper = path.join(repo, 'scripts/qa/shared-researcher-agent-client.py');
const exported = path.join(output, 'reviewed-workflow-export');
const hash = async file => { const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable_sha256: await hash(executablePath), asar_sha256: await hash(path.join(bundle, 'Contents/Resources/app.asar')), worker_sha256: await hash(worker) });
const cli = async (...args) => JSON.parse((await exec(worker, ['--loci', '--json', ...args], { timeout: 120000, maxBuffer: 16 * 1024 ** 2 })).stdout);
const operation = (name, request) => cli('execute', '--project', study, name, '--request', JSON.stringify(request));
const receipt = { schema: 'loci.researcher-activation-packaged-qa/v1', status: 'running', started_at: new Date().toISOString(), source_commit: sourceCommit,
  output, study, checks: [], screenshots: [], renderer_errors: [], network_requests: [], picker_substitutions: [],
  scientific_scope: 'Generated known-grid sources; engineering interaction checks only, no biological validation',
  authority: ['Reuses the existing shared-researcher-agent generated-fixture oracle; no duplicate executor/oracle implementation.', 'Existing core journeys remain authority for wider scientific behavior.'],
  not_exercised: ['Manual researcher usability', 'Model provisioning/execution', 'Native volume footer (lead native pass)', 'All scientific executor oracles'] };
let app, page, failure;
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
async function wait(read, accept, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await page.waitForTimeout(100); }
  throw new Error(`Timed out: ${label}`);
}
async function fullscreen(enabled) {
  await app.evaluate(({ BrowserWindow }, enabled) => new Promise((resolve, reject) => {
    const window = BrowserWindow.getAllWindows()[0]; if (window.isFullScreen() === enabled) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('Native fullscreen transition deadline')), 15000);
    window.once(enabled ? 'enter-full-screen' : 'leave-full-screen', () => { clearTimeout(timer); resolve(); }); window.setFullScreen(enabled);
  }), enabled); await frame();
}
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function shot(name) { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target }); receipt.screenshots.push(path.basename(target)); }
async function appearance(theme, large = false) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Application theme', { exact: true }).selectOption(theme);
  await page.getByRole('radiogroup', { name: 'Interface text size', exact: true }).getByRole('radio', { name: large ? 'Large' : 'Standard', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Interface motion', exact: true }).getByRole('radio', { name: /Reduce motion/u }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected.theme && JSON.parse(localStorage.getItem('loci.preferences.v1')).textSize === expected.size, { theme, size: large ? 'large' : 'standard' });
  await frame();
}
const footer = () => page.getByRole('group', { name: 'Workflow actions and status', exact: true });
const workflow = () => page.getByRole('region', { name: 'Visual workflow builder', exact: true });
async function footerVisible() {
  const geometry = await footer().evaluate(element => {
    const r = element.getBoundingClientRect(), b = document.querySelector('.workflow-body').getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, height: r.height, viewport: innerHeight, bodyBottom: b.bottom, hit: Boolean(at && element.contains(at)), outsideBody: !document.querySelector('.workflow-body').contains(element) };
  });
  assert.ok(geometry.outsideBody && geometry.hit && geometry.top >= 0 && geometry.bottom <= geometry.viewport + 1 && geometry.bodyBottom <= geometry.top + 1, JSON.stringify(geometry));
  return geometry;
}
async function templateDownload(sheet, csv, name) {
  const table = sheet.getByRole('region', { name: 'Sample sheet before and after', exact: true }); await table.waitFor(); const beforeTable = await table.innerText();
  assert.equal(await sheet.getByRole('button', { name: 'Apply to 1 images', exact: true }).isEnabled(), true);
  const downloaded = path.join(output, `${name}-template.csv`);
  await app.evaluate(({ BrowserWindow }, target) => {
    globalThis.__lociActivationDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      const filename = item.getFilename();
      if (filename !== 'Loci-sample-sheet.csv') { item.cancel(); globalThis.__lociActivationDownload = { state: 'unexpected-file', filename }; return; }
      item.setSavePath(target);
      item.once('done', (_event, state) => { globalThis.__lociActivationDownload = { state, filename }; });
    });
  }, downloaded);
  receipt.picker_substitutions.push({ kind: 'Electron local CSV download destination', path: downloaded });
  await sheet.getByRole('button', { name: 'Download template', exact: true }).click();
  const download = await wait(() => app.evaluate(() => globalThis.__lociActivationDownload), Boolean, 'actual Electron CSV download completion'); assert.equal(download.state, 'completed');
  assert.equal(await fs.readFile(downloaded, 'utf8'), (await inspect('sample_sheet_template')).csv_text);
  assert.equal(await sheet.getByLabel('Sample sheet CSV', { exact: true }).inputValue(), csv); assert.equal(await table.innerText(), beforeTable);
  await wait(() => sheet.getByRole('button', { name: 'Apply to 1 images', exact: true }).isEnabled(), Boolean, 'unchanged preview after template download');
  receipt.checks.push({ name: `template-download-preserves-${name}-csv-and-preview`, csv_sha256: createHash('sha256').update(csv).digest('hex'), template_sha256: await hash(downloaded), download });
}
const imageState = () => page.locator('[data-viewer-source]').first().evaluate(element => ({ source: element.getAttribute('data-viewer-source'), camera: JSON.parse(element.getAttribute('data-camera')) }));
function contrast(foreground, background) {
  const rgb = value => { const values = value.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[ ,/]+/u).map(Number); assert.ok(values && values.length >= 3 && values.slice(0, 3).every(Number.isFinite), `Expected computed RGB: ${value}`); assert.equal(values[3] ?? 1, 1, 'Enabled action colors must be opaque'); return values.slice(0, 3); };
  const luminance = value => rgb(value).map(channel => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
try {
  receipt.build = await identity(); receipt.harness_sha256 = await hash(import.meta.filename); receipt.fixture_helper_sha256 = await hash(helper);
  const build = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(build.sourceRevision, sourceCommit); assert.equal(build.sourceDirty, false);
  receipt.build_manifest = build; receipt.build_manifest_sha256 = await hash(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.match(build.sourceTree, /^[a-f0-9]{40}$/u); receipt.source_tree = build.sourceTree;
  receipt.harness_git_head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  receipt.fixture = JSON.parse((await exec(python, [helper, 'fixture', output, '--size', '64'], { timeout: 30000 })).stdout);
  await cli('create', '--project', study, '--title', 'Activation QA');
  const imported = await cli('import', '--project', study, receipt.fixture.sources[0].path);
  const source = imported.sources.find(item => item.sha256 === receipt.fixture.sources[0].sha256); assert.ok(source);
  await operation('sample', { id: source.id, expected_revision: 0, data: { study: 'Activation QA', sample: 'Authored grid', condition: 'Technical', biological_replicate: 'Authored-1', plate: null, well: null } });
  // Independent ordinary workflow authored through the same frozen CLI contract before GUI launch.
  const nodes = [{ id: 'source', type: 'source', settings: {} }, { id: 'segment', type: 'segment', settings: { method: 'components', threshold: 50, min_size: 1, polarity: 'bright', exclude_border: false } },
    { id: 'measure', type: 'measure', settings: { measurement_channels: [0], gates: [] } }, { id: 'review', type: 'review', settings: {} }, { id: 'export', type: 'export', settings: {} }];
  const definition = { schema: 'loci.workflow/v1', name: 'Independent authored grid workflow', nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })), working_bytes: 512 * 1024 ** 2 };
  const validated = await operation('workflow_validate', { definition }); assert.deepEqual(validated.definition, definition);
  const saved = (await operation('workflow_save', { workflow_id: randomBytes(16).toString('hex'), expected_revision: 0, definition })).workflow;
  assert.equal(saved.data.definition_sha256, validated.definition_sha256); receipt.saved_workflow = saved;
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(output, 'user-data')}`], timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await app.evaluate(({ dialog, BrowserWindow }, values) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 900 });
    dialog.showOpenDialog = async (...args) => { assertTitle(args.at(-1)?.title, 'Open research study'); return { canceled: false, filePaths: [values.study] }; };
    dialog.showSaveDialog = async (...args) => { assertTitle(args.at(-1)?.title, 'Export reviewed result bundle'); return { canceled: false, filePath: values.exported }; };
    dialog.showMessageBox = async (...args) => { assertTitle(args.at(-1)?.title, 'Quit Loci?'); return { response: 0, checkboxChecked: false }; };
    function assertTitle(actual, expected) { if (actual !== expected) throw new Error(`Unexpected QA picker: ${actual}; expected ${expected}`); }
  }, { study, exported });
  receipt.picker_substitutions.push({ title: 'Open research study', path: study }, { title: 'Export reviewed result bundle', path: exported }, { title: 'Quit Loci?', response: 'Quit Loci; no save-failure bypass' });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace', exact: true }).waitFor();
  await waitForSnapshot(page, value => value?.sources.some(item => item.id === source.id), 'isolated authored source');
  await page.locator(`button[data-source-id="${source.id}"]`).click();
  await selectWorkbenchTool(page, 'Display');
  for (const [label, key] of [['X', 'x'], ['Y', 'y'], ['Width', 'width'], ['Height', 'height'], ['C', 'c']]) await setSelectionField(page, label, receipt.fixture.selection[key]);
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical');
  await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  await page.getByLabel('Threshold', { exact: true }).fill('50'); await page.getByLabel('Minimum object measure', { exact: true }).fill('1');
  await selectWorkbenchTool(page, 'Quantify'); await page.getByRole('button', { name: 'Recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Add explicit gate', exact: true }).click();
  let gate = page.getByLabel('Gate 1 threshold', { exact: true }); await gate.fill('-7.25'); await gate.fill('');
  assert.equal(await gate.inputValue(), '');
  const beforeBlocked = await snapshot();
  await selectWorkbenchTool(page, 'Analyze'); assert.equal(await page.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(), false);
  await selectWorkbenchTool(page, 'Study'); assert.equal(await page.getByRole('button', { name: 'Save validated recipe', exact: true }).isEnabled(), false);
  await selectWorkbenchTool(page, 'Workflow');
  for (const name of ['Save workflow', 'Use current recipe', 'Check workflow', 'Run workflow']) assert.equal(await workflow().getByRole('button', { name, exact: true }).isEnabled(), false, name);
  assert.deepEqual((await snapshot()).jobs, beforeBlocked.jobs); assert.deepEqual((await snapshot()).recipes, beforeBlocked.recipes);
  await workflow().getByLabel('Saved workflow', { exact: true }).selectOption(saved.id); await workflow().getByRole('button', { name: 'Open', exact: true }).click();
  await workflow().getByText('Opened revision 1.', { exact: true }).waitFor();
  assert.equal(await workflow().getByRole('button', { name: 'Run workflow', exact: true }).isEnabled(), true);
  await selectWorkbenchTool(page, 'Quantify'); gate = page.getByLabel('Gate 1 threshold', { exact: true }); assert.equal(await gate.inputValue(), '');
  await gate.fill('-7.25e'); await selectWorkbenchTool(page, 'Analyze');
  assert.equal(await page.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(), false);
  await selectWorkbenchTool(page, 'Quantify'); gate = page.getByLabel('Gate 1 threshold', { exact: true }); assert.equal(await gate.inputValue(), '-7.25e');
  await gate.press('Escape'); assert.equal(await gate.inputValue(), '-7.25');
  receipt.checks.push({ name: 'empty-and-partial-gate-draft-retained-refused-and-escape-restored', applied: -7.25, independent_workflow_opened: saved.id });
  // Actual native-window layout and real preference controls, no CSS/React state injection.
  for (const [width, height, theme, large] of [[1024, 720, 'graphite', false], [1440, 900, 'graphite', false], [1024, 720, 'paper', true], [1440, 900, 'paper', true]]) {
    await appearance(theme, large); await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { width, height }); await frame();
    await selectWorkbenchTool(page, 'Display'); assert.equal(await page.locator('.compact-channel-controls').count(), 0, 'Display inspector owns the complete channel editor');
    await selectWorkbenchTool(page, 'Analyze'); const compact = page.locator('details.compact-channel-controls');
    const imageWidth = (await page.locator('[data-viewer-source]').first().boundingBox()).width;
    if (width === 1024) { assert.ok(imageWidth >= 395 && imageWidth < 640, `Minimum native window usable image width ${imageWidth}`); await wait(() => compact.evaluate(element => element.open), open => !open, 'narrow compact controls collapsed'); }
    await selectWorkbenchTool(page, 'Workflow'); await footerVisible();
    const before = await imageState(); await page.getByRole('button', { name: 'Focus workflow', exact: true }).click(); await frame();
    assert.equal(await page.locator('#research-image-stage').isVisible(), false); await footerVisible();
    await page.getByRole('button', { name: 'Show image', exact: true }).click(); await frame(); assert.deepEqual(await imageState(), before);
    await workflow().locator('.workflow-body').hover(); await page.mouse.wheel(0, 10000); await frame();
    const geometry = await footerVisible(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No app horizontal overflow');
    const actual = await app.evaluate(({ BrowserWindow }) => ({ outer: BrowserWindow.getAllWindows()[0].getBounds(), content: BrowserWindow.getAllWindows()[0].getContentBounds() }));
    receipt.checks.push({ name: 'native-layout', requested: { width, height, theme, large }, actual, image_width: imageWidth, footer: geometry, focus_preserved: before });
    await shot(`layout-${width}-${height}-${theme}-${large ? 'large' : 'standard'}`);
  }
  await appearance('graphite'); await fullscreen(true);
  const fullscreenGeometry = await footerVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No fullscreen horizontal overflow');
  const fullscreenBounds = await app.evaluate(({ BrowserWindow }) => ({ fullscreen: BrowserWindow.getAllWindows()[0].isFullScreen(), outer: BrowserWindow.getAllWindows()[0].getBounds(), content: BrowserWindow.getAllWindows()[0].getContentBounds() }));
  assert.equal(fullscreenBounds.fullscreen, true); receipt.checks.push({ name: 'actual-native-fullscreen-layout', actual: fullscreenBounds, footer: fullscreenGeometry }); await shot('layout-native-fullscreen');
  await fullscreen(false);
  await appearance('graphite'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 900 }));
  // The independent saved workflow remains executable while the host gate draft is invalid.
  await selectWorkbenchTool(page, 'Quantify'); await page.getByLabel('Gate 1 threshold', { exact: true }).fill('');
  await selectWorkbenchTool(page, 'Workflow'); await footer().getByRole('button', { name: 'Run workflow', exact: true }).click();
  await workflow().getByText(/3 objects · review required/u).waitFor({ timeout: 120000 });
  const afterRun = await snapshot(), job = [...afterRun.jobs].reverse().find(item => item.operation === 'workflow_run' && item.request.task_request?.workflow_id === saved.id);
  assert.equal(job?.state, 'succeeded'); const status = await inspect('workflow_status', { run_id: job.id });
  assert.equal(status.run.data.definition_sha256, saved.data.definition_sha256); assert.equal(status.run.data.source_sha256, source.sha256); assert.equal(status.run.data.source_id, source.id); assert.deepEqual(status.run.data.selection, receipt.fixture.selection); assert.equal(status.run.data.workflow_revision, saved.revision);
  const result = afterRun.results.find(item => item.id === status.run.data.result_id); assert.ok(result); assert.equal(result.revision_hash, status.run.data.revision_hash);
  assert.equal(await footer().getByRole('button', { name: 'Export reviewed result', exact: true }).isEnabled(), false);
  await footer().getByRole('button', { name: 'Inspect exact result', exact: true }).click();
  await wait(() => footer().getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), Boolean, 'exact displayed result before review');
  await footer().getByRole('button', { name: 'Mark reviewed', exact: true }).click(); await workflow().getByText(/3 objects · reviewed/u).waitFor();
  await footer().getByRole('button', { name: 'Export reviewed result', exact: true }).click(); await workflow().getByText(/3 objects · exported/u).waitFor({ timeout: 120000 });
  const exportJson = await json(path.join(exported, 'result.json')), manifest = await json(path.join(exported, 'manifest.json'));
  assert.equal(exportJson.result.id, result.id); assert.equal(exportJson.result.revision_hash, result.revision_hash); assert.equal(exportJson.review.disposition, 'reviewed'); assert.equal(exportJson.source.sha256, source.sha256);
  assert.ok(manifest.files.some(item => item.name === 'workflow.json'));
  const workflowExport = await json(path.join(exported, 'workflow.json'));
  assert.equal(workflowExport.result_id, result.id); assert.equal(workflowExport.revision_hash, result.revision_hash);
  assert.equal(workflowExport.workflow.workflow_id, saved.id); assert.equal(workflowExport.workflow.definition_sha256, saved.data.definition_sha256);
  for (const item of manifest.files) { assert.equal(path.basename(item.name), item.name); assert.equal(await hash(path.join(exported, item.name)), item.sha256); }
  const oracle = JSON.parse((await exec(python, [helper, 'verify-result', study, result.id, '0'], { timeout: 30000, maxBuffer: 4 * 1024 ** 2 })).stdout);
  assert.equal(oracle.verified, true); assert.equal(oracle.revision_hash, result.revision_hash);
  assert.deepEqual(exportJson.result.provenance.measurements.map(row => ({ label: row.label, voxel_count: row.voxel_count, measure: row.measure, mean: Object.values(row.intensity)[0].mean })), oracle.measurements);
  for (const key of ['image', 'labels']) assert.equal(exportJson.artifact_files[key].sha256, oracle.arrays[key], `Exported ${key} must retain the independently checked source/result array`);
  receipt.checks.push({ name: 'existing-source-oracle-and-exported-raw-measurements', ...oracle });
  receipt.checks.push({ name: 'independent-workflow-exact-footer-review-export', workflow_id: saved.id, run_id: job.id, result_id: result.id, revision_hash: result.revision_hash, manifest_sha256: await hash(path.join(exported, 'manifest.json')) });
  await footer().getByRole('button', { name: 'Rerun / check', exact: true }).click();
  for (const theme of ['graphite', 'midnight', 'paper', 'aurora', 'ember', 'lagoon', 'fiji']) {
    await appearance(theme); const run = footer().getByRole('button', { name: 'Run workflow', exact: true }); assert.equal(await run.isEnabled(), true);
    const samples = [];
    for (const hover of [false, true]) {
      if (hover) await run.hover(); else await page.mouse.move(0, 0);
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getTiming().iterations === Infinity || !['running', 'pending'].includes(animation.playState)));
      const colors = await run.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      const ratio = contrast(colors.foreground, colors.background); assert.ok(ratio >= 4.5, `${theme} hover=${hover} ${ratio}: ${JSON.stringify(colors)}`); samples.push({ hover, ...colors, ratio });
    }
    receipt.checks.push({ name: 'enabled-workflow-run-contrast', theme, samples }); await shot(`contrast-${theme}`);
  }
  // Import is the ordinary file-chooser route. Downloading guidance must not mutate an exact preview.
  await selectWorkbenchTool(page, 'Quantify'); await page.getByLabel('Gate 1 threshold', { exact: true }).press('Escape');
  await selectWorkbenchTool(page, 'Study', 'Samples'); const sheet = page.getByRole('region', { name: 'Sample sheet', exact: true });
  const csv = `source_id,study,sample,condition,biological_replicate,plate,well\n${source.id},Activation QA,Authored grid,Changed,Authored-1,,\n`;
  const csvFile = path.join(output, 'authored-samples.csv'); await fs.writeFile(csvFile, csv);
  const chooser = page.waitForEvent('filechooser'); await sheet.getByRole('button', { name: 'Import sample sheet…', exact: true }).click(); await (await chooser).setFiles(csvFile);
  receipt.picker_substitutions.push({ kind: 'CSV file chooser', path: csvFile });
  await wait(() => sheet.getByLabel('Sample sheet CSV', { exact: true }).inputValue(), value => value === csv, 'exact imported CSV');
  await sheet.getByRole('button', { name: 'Preview sample sheet', exact: true }).click();
  await templateDownload(sheet, csv, 'imported');
  await sheet.locator('details > summary').filter({ hasText: /^Paste CSV$/u }).click();
  const pasted = csv.replace(',Changed,', ',Pasted,'); await sheet.getByLabel('Sample sheet CSV', { exact: true }).fill(pasted);
  await sheet.getByRole('button', { name: 'Preview sample sheet', exact: true }).click(); await templateDownload(sheet, pasted, 'pasted');
  await shot('sample-sheet-preview-retained');
  const beforeModel = await snapshot(); await selectWorkbenchTool(page, 'Model'); await page.getByText('No model packages in this study.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Import model package…', exact: true }).isEnabled(), true); await shot('model-empty-state');
  await page.getByRole('button', { name: 'Open Segment & measure', exact: true }).click(); await page.getByRole('button', { name: 'Run recipe', exact: true }).waitFor();
  const afterModel = await snapshot(); assert.deepEqual(afterModel.jobs, beforeModel.jobs); assert.deepEqual(afterModel.results, beforeModel.results);
  receipt.checks.push({ name: 'model-empty-state-routes-without-provisioning' });
  for (const item of receipt.fixture.sources) assert.equal(await hash(item.path), item.sha256, 'Generated source bytes immutable');
  assert.deepEqual(receipt.network_requests, [], 'Offline generated journey must not request network resources'); assert.deepEqual(receipt.renderer_errors, []);
  assert.deepEqual(await identity(), receipt.build); receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) try { await shot('failure'); } catch (capture) { receipt.capture_failure = String(capture); }
} finally {
  if (app) try {
    const child = app.process(), exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = app.waitForEvent('close', { timeout: 30000 }); await app.evaluate(({ app }) => app.quit()); await closed;
    let timer; try { receipt.process_exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned Electron process did not exit')), 10000); })]); } finally { clearTimeout(timer); }
    assert.equal(receipt.process_exit.code, 0); assert.equal(receipt.process_exit.signal, null);
  } catch (error) {
    receipt.status = 'failed'; receipt.cleanup_failure = error.stack ?? String(error); failure ??= error;
    const child = app.process();
    if (child.exitCode === null && !child.signalCode) {
      receipt.forced_cleanup = 'SIGTERM to this harness-owned Electron child after graceful cleanup failed';
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM'); let timer;
      try { receipt.forced_exit = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 10000); })]); } finally { clearTimeout(timer); }
    }
  }
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, receipt: path.join(output, 'receipt.json') }));
}
if (failure) throw failure;
