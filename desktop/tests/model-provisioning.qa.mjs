/** Explicit live-network packaged model setup QA. Downloads the pinned cpsam_v2
 * artifact into an isolated model home. Does not run inference or alter user models. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile), repo = path.resolve(import.meta.dirname, '../..');
const bundle = process.env.LOCI_PACKAGED_APP, python = process.env.LOCI_QA_PYTHON;
const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
assert.equal(process.platform, 'darwin');
assert.equal(process.env.LOCI_QA_ALLOW_MODEL_DOWNLOAD, '1', 'Explicit network acceptance is required');
for (const value of [bundle, python, process.env.LOCI_QA_OUTPUT_ROOT]) assert.ok(value && path.isAbsolute(value));
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/u);
const output = await fs.mkdtemp(path.join(process.env.LOCI_QA_OUTPUT_ROOT, 'model-provisioning-'));
const modelHome = path.join(output, 'models'); await fs.mkdir(modelHome);
const executablePath = path.join(bundle, 'Contents/MacOS/Loci');
const hash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(bundle, 'Contents/Resources/app.asar')), worker: await hash(path.join(bundle, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { schema: 'loci.model-provisioning-packaged-qa/v1', status: 'running', output, source_commit: sourceCommit,
  started_at: new Date().toISOString(), scope: 'Explicit model provisioning engineering QA; no inference or scientific qualification', checks: [], screenshots: [], renderer_errors: [] };
let app, page, fixture, session = 0, failure;
const status = () => page.evaluate(() => window.loci.getCellposeStatus('cellpose-sam-v2'));
async function wait(read, accept, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (accept(value)) return value; await page.waitForTimeout(100); }
  throw new Error('Timed out: ' + label);
}
async function files(root) {
  const values = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) values.push(...await files(filename));
    else values.push({ filename, bytes: (await fs.stat(filename)).size });
  }
  return values;
}
async function shot(name) { const filename = path.join(output, name + '.png'); await page.screenshot({ path: filename }); receipt.screenshots.push({ name, sha256: await hash(filename) }); }
async function launch() {
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + path.join(output, 'profile-' + ++session)],
    env: { ...process.env, LOCI_MODEL_HOME: modelHome }, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  await app.evaluate(({ BrowserWindow, dialog }, study) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 });
    dialog.showOpenDialog = async (...args) => {
      if (args.at(-1)?.title !== 'Open research study') throw new Error('Unexpected picker');
      return { canceled: false, filePaths: [study] };
    };
  }, fixture.study);
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.locator(`button[data-source-id="${fixture.fields[0].source_id}"]`).click();
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('cellpose-sam-v2');
  await page.locator('.cellpose-panel').getByText('Checking local model…').waitFor({ state: 'hidden' });
}
async function close() {
  if (!app) return;
  const closing = app, done = closing.waitForEvent('close', { timeout: 30000 });
  await closing.evaluate(({ app }) => app.quit()); await done; app = undefined; page = undefined;
}
try {
  receipt.build = await identity(); receipt.harness_sha256 = await hash(import.meta.filename);
  receipt.build_manifest = await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json'));
  assert.equal(receipt.build_manifest.sourceRevision, sourceCommit); assert.equal(receipt.build_manifest.sourceDirty, false);
  fixture = JSON.parse((await exec(python, [path.join(repo, 'scripts/fixtures/research_program_qa.py'), 'create', '--root', path.join(output, 'fixture')], { timeout: 60000 })).stdout);
  await launch(); const initial = await status(); receipt.initial = initial;
  assert.equal(initial.model.verified, false); assert.equal(initial.model.present, false);
  const panel = page.locator('.cellpose-panel');
  await panel.getByRole('button', { name: 'Download verified checkpoint', exact: true }).click();
  const partial = await wait(() => files(modelHome), values => values.some(value => value.bytes >= 65536 && value.filename.endsWith('artifact.part')), 'actual partial download');
  receipt.cancel_observed_bytes = partial.reduce((sum, value) => sum + value.bytes, 0);
  await panel.getByRole('button', { name: 'Cancel download', exact: true }).click();
  await page.getByText('Model download cancelled. No checkpoint was imported.', { exact: true }).waitFor();
  await wait(() => files(modelHome), values => values.length === 0, 'cancelled artifact cleanup');
  assert.equal((await status()).model.verified, false);
  await shot('01-cancelled'); receipt.checks.push('native-download-cancel-after-received-bytes-without-import');
  await panel.getByRole('button', { name: 'Download verified checkpoint', exact: true }).click();
  await panel.getByText('Ready locally', { exact: true }).waitFor({ timeout: 300000 });
  const installed = await status(); receipt.installed = installed;
  assert.equal(installed.profileId, 'cellpose-sam-v2'); assert.equal(installed.model.artifactId, 'cpsam_v2');
  assert.equal(installed.model.verified, true); assert.equal(installed.ready, true);
  const retained = await files(modelHome);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].bytes, installed.model.expectedSizeBytes);
  assert.equal(await hash(retained[0].filename), installed.model.expectedSha256);
  const other = await page.evaluate(() => window.loci.getCellposeStatus('cellpose-sam'));
  assert.equal(other.model.verified, false);
  await panel.locator('details.cellpose-identity > summary').click();
  await shot('02-verified-profile-and-validation'); receipt.checks.push('native-full-pinned-download-and-atomic-import', 'independent-checkpoint-size-sha256-and-profile-isolation');
  await close(); await launch();
  await page.locator('.cellpose-panel').getByText('Ready locally', { exact: true }).waitFor();
  assert.deepEqual((await status()).model, installed.model);
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(snapshot.jobs.filter(job => job.operation === 'cellpose_run').length, 0);
  await shot('03-fresh-profile-ready'); await close();
  assert.deepEqual(await identity(), receipt.build); assert.deepEqual(receipt.renderer_errors, []);
  receipt.checks.push('fresh-process-profile-provisioning-reopen-without-inference'); receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  if (page) { await shot('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  await close().catch(error => { receipt.cleanup_error = error.message; receipt.status = 'failed'; failure ??= error; });
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: receipt.status, output, error: receipt.error?.message }) + '\n');
}
if (failure) throw failure;
