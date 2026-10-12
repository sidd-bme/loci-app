/** Packaged workflow authoring on retained, licensed real microscopy images. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool, fileMenuAction } from './workbench-qa-helpers.mjs';

const appPath = process.env.LOCI_PACKAGED_APP;
const sourceStudy = process.env.LOCI_WORKFLOW_STUDY;
assert.ok(appPath && sourceStudy, 'Set explicit packaged app and retained real-image study.');
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? '../.loci/evidence/2026-10-03/visual-workflows/packaged-real');
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, 'run-'));
const study = path.join(output, 'Real workflow.loci-study');
await fs.cp(sourceStudy, study, { recursive: true, errorOnExist: true, force: false });
const hash = async (file) => { const h = createHash('sha256'); for await (const block of createReadStream(file)) h.update(block); return h.digest('hex'); };
const executablePath = path.join(appPath, 'Contents/MacOS/Loci');
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(appPath, 'Contents/Resources/app.asar')),
  worker: await hash(path.join(appPath, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { started_at: new Date().toISOString(), app: appPath, build: await identity(), study, source_study: sourceStudy, checks: [], status: 'running' };
let app;
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(output, 'user-data')}`], timeout: 120000 });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, dialog }, studyPath) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [studyPath] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  const initial = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.ok(initial.sources.length >= 2);
  const source = initial.sources[0];
  await page.locator('.research-sources-list button').filter({ hasText: source.name }).click();
  await selectWorkbenchTool(page, 'Workflow');
  const panel = page.getByRole('region', { name: 'Visual workflow builder' });
  await panel.waitFor();
  assert.ok(await page.locator('main.is-workflow-workspace').count());
  await panel.getByLabel('Workflow name', { exact: true }).fill('Real nuclei analysis');
  await panel.getByRole('button', { name: 'Select Segment objects', exact: true }).click();
  await panel.getByLabel('Workflow threshold method', { exact: true }).selectOption('otsu');
  await panel.getByLabel('Workflow min size', { exact: true }).fill('0');
  await panel.getByLabel('Add workflow processing', { exact: true }).selectOption('gaussian');
  await panel.getByLabel('Workflow sigma', { exact: true }).fill('1');
  await panel.getByRole('button', { name: 'Population filter', exact: true }).click();
  await panel.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workflow-save-state')?.textContent === 'Saved revision 1');
  await panel.getByRole('button', { name: 'Add range', exact: true }).click();
  await panel.getByLabel('Workflow population minimum 1', { exact: true }).fill('100');
  await panel.getByLabel('Workflow population maximum 1', { exact: true }).fill('1000');
  await panel.getByRole('button', { name: 'Save revision', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workflow-save-state')?.textContent === 'Saved revision 2');
  const saved = await page.evaluate(async () => (await window.lociResearch.execute('workflow_list', {})).workflows.find((item) => item.data.definition.name === 'Real nuclei analysis'));
  assert.ok(saved && saved.revision === 2);
  await panel.getByRole('button', { name: 'Select gaussian', exact: true }).click();
  await panel.getByRole('button', { name: 'Preview through this step', exact: true }).click();
  await panel.getByText(/Preview through gaussian/).waitFor();
  await page.mouse.move(0, 0);
  assert.equal(await panel.locator('.workflow-graph-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'The seven-node chain fits the wide workspace.');
  await page.screenshot({ path: path.join(output, '01-real-workflow-preview.png') });
  await panel.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await panel.getByText(/objects · waiting review/).waitFor({ timeout: 120000 });
  const after = await page.evaluate(() => window.lociResearch.getSnapshot());
  const job = [...after.jobs].reverse().find((item) => item.operation === 'workflow_run' && item.request.task_request.workflow_id === saved.id);
  assert.ok(job && job.state === 'succeeded');
  const request = job.request.task_request;
  const status = await page.evaluate((id) => window.lociResearch.execute('workflow_status', { run_id: id }), job.id);
  const result = after.results.find((item) => item.id === status.run.data.result_id);
  assert.ok(result && result.object_count > 0);
  const direct = await page.evaluate(async (binding) => {
    const resolved = await window.lociResearch.execute('workflow_preflight', binding);
    return window.lociResearch.execute('run_recipe', { source_id: resolved.source_id, selection: resolved.selection, recipe: resolved.recipe });
  }, request);
  const workflowRows = await page.evaluate((id) => window.lociResearch.execute('result', { result_id: id, offset: 0, limit: 1000 }), result.id);
  assert.equal(direct.result.object_count, result.object_count);
  assert.deepEqual(direct.measurements, workflowRows.measurements);
  receipt.checks.push({ name: 'real-workflow-direct-recipe-parity', source_sha256: source.sha256, result_id: result.id, revision_hash: result.revision_hash, count: result.object_count });
  assert.equal(await panel.getByRole('button', { name: 'Export reviewed result', exact: true }).isEnabled(), false);
  await panel.getByRole('button', { name: 'Inspect exact result', exact: true }).click();
  await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await panel.getByText(/objects · reviewed/).waitFor();
  const destination = path.join(output, 'reviewed-workflow-export');
  await app.evaluate(({ dialog }, dest) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest }); }, destination);
  await panel.getByRole('button', { name: 'Export reviewed result', exact: true }).click();
  await panel.getByText(/objects · exported/).waitFor({ timeout: 120000 });
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((item) => item.name === 'workflow.json'));
  assert.ok(manifest.files.some((item) => item.name === 'selected_measurements.csv'));
  for (const file of manifest.files) assert.equal(await hash(path.join(destination, file.name)), file.sha256);
  receipt.checks.push({ name: 'native-reviewed-workflow-export', manifest_sha256: await hash(path.join(destination, 'manifest.json')), files: manifest.files.length });
  await page.screenshot({ path: path.join(output, '02-real-workflow-exported.png') });
  await panel.locator('.workflow-batch summary').click();
  const targets = panel.locator('.workflow-batch-sources input');
  for (let index = 0; index < await targets.count(); index++) await targets.nth(index).setChecked(index < 2);
  const jobsBeforeBatch = new Set((await page.evaluate(() => window.lociResearch.getSnapshot())).jobs.map((item) => item.id));
  await panel.getByRole('button', { name: 'Check and run batch', exact: true }).click();
  await panel.getByText('Batch requests retained. Follow Jobs for exact status and recovery.', { exact: true }).waitFor({ timeout: 120000 });
  const batchJobs = (await page.evaluate(() => window.lociResearch.getSnapshot())).jobs.filter((item) => !jobsBeforeBatch.has(item.id));
  assert.equal(batchJobs.length, 2);
  assert.ok(batchJobs.every((item) => item.operation === 'workflow_run' && item.state === 'succeeded'));
  for (const item of batchJobs) {
    const batchStatus = await page.evaluate((id) => window.lociResearch.execute('workflow_status', { run_id: id }), item.id);
    assert.equal(batchStatus.state, 'waiting_review');
  }
  await panel.getByRole('button', { name: 'Resume batch', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workflow-save-state')?.textContent === 'Saved revision 2');
  assert.equal((await page.evaluate(() => window.lociResearch.getSnapshot())).jobs.length, jobsBeforeBatch.size + 2);
  receipt.checks.push({ name: 'two-source-batch-and-completed-resume-no-duplicate', jobs: batchJobs.map((item) => item.id) });
  await panel.locator('.workflow-batch summary').click();
  await panel.getByLabel('Workflow sigma', { exact: true }).fill('2');
  await panel.getByText(/Outdated execution/).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), false);
  await panel.getByLabel('Workflow sigma', { exact: true }).fill('not-a-number');
  assert.equal(await panel.getByRole('button', { name: 'Save revision', exact: true }).isEnabled(), false);
  await panel.getByLabel('Workflow sigma', { exact: true }).press('Escape');
  await panel.getByRole('button', { name: 'Open', exact: true }).click();
  await panel.getByRole('button', { name: 'Select gaussian', exact: true }).click();
  assert.equal(await panel.getByLabel('Workflow sigma', { exact: true }).inputValue(), '1');
  await panel.getByLabel('Connect processing input after', { exact: true }).selectOption('measure');
  await panel.getByRole('alert').filter({ hasText: 'Image processing can connect only' }).waitFor();
  receipt.checks.push({ name: 'changed-settings-invalid-draft-and-invalid-connection-rejected' });
  // Draft is retained across task switching within the same study.
  await panel.getByLabel('Workflow name', { exact: true }).fill('Retained unsaved workflow draft');
  await selectWorkbenchTool(page, 'Display');
  await selectWorkbenchTool(page, 'Workflow');
  assert.equal(await panel.getByLabel('Workflow name', { exact: true }).inputValue(), 'Retained unsaved workflow draft');
  await panel.getByRole('button', { name: 'Open', exact: true }).click();
  await panel.getByText(/Opened revision 2/).waitFor();
  for (const theme of ['graphite', 'paper', 'midnight', 'aurora', 'ember', 'lagoon', 'fiji']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; document.documentElement.dataset.textSize = value === 'paper' ? 'large' : 'standard'; }, theme);
    await app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setBounds({ width, height: 900 }); }, theme === 'paper' ? 1050 : 1440);
    await panel.getByRole('button', { name: 'Select Segment objects', exact: true }).click();
    await page.mouse.move(0, 0);
    // Poll the current finite transitions. Retired CSS Animation.finished
    // promises can stay pending after a theme replaces their underlying effect.
    await page.waitForFunction(() => document.getAnimations().every((animation) =>
      animation.effect?.getTiming().iterations === Infinity || !['running', 'pending'].includes(animation.playState)));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, `theme-${theme}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No whole-window horizontal overflow.');
  }
  // Reopen the actual saved study; the definition and reviewed execution survive.
  await fileMenuAction(page, 'Open study');
  await page.waitForFunction(() => !document.querySelector('main.research-workbench')?.hasAttribute('inert'));
  await selectWorkbenchTool(page, 'Workflow');
  await panel.getByLabel('Saved workflow', { exact: true }).selectOption(saved.id);
  await panel.getByRole('button', { name: 'Open', exact: true }).click();
  await panel.getByText(/Opened revision 2/).waitFor();
  const reopenedStatus = await page.evaluate((id) => window.lociResearch.execute('workflow_status', { run_id: id }), job.id);
  assert.equal(reopenedStatus.state, 'exported');
  assert.equal(reopenedStatus.run.data.definition_sha256, saved.data.definition_sha256);
  assert.deepEqual(errors, []);
  assert.deepEqual(await identity(), receipt.build);
  receipt.checks.push({ name: 'saved-study-reopen-exact-workflow-and-review', workflow_id: saved.id, definition_sha256: saved.data.definition_sha256 });
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.stack ?? String(error);
  if (app) await app.firstWindow().then((page) => page.screenshot({ path: path.join(output, 'failure.png') })).catch(() => {});
  throw error;
} finally {
  receipt.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await app?.close().catch(() => {});
  console.log(JSON.stringify({ status: receipt.status, output, checks: receipt.checks.length }));
}
