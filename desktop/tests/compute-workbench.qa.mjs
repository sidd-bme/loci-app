/** Current packaged Analyze -> real remote CPU/CUDA -> recover -> review journey.
 * Requires a task-owned LOCI_REMOTE_QA_CONFIG JSON with profile and public source
 * {path, sha256, dataset_url, license}, LOCI_REMOTE_QA_CASE classical|cpu|gpu|cancel,
 * LOCI_QA_PYTHON, LOCI_PACKAGED_APP and an explicit LOCI_QA_OUTPUT_ROOT.
 * A case owns one durable study and never submits another run when one exists.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool, setSelectionField } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile);
assert.equal(process.platform, 'darwin');
for (const name of ['LOCI_PACKAGED_APP', 'LOCI_REMOTE_QA_CONFIG', 'LOCI_REMOTE_QA_CASE', 'LOCI_QA_PYTHON', 'LOCI_QA_OUTPUT_ROOT'])
  assert.ok(process.env[name], `Set ${name}`);
const appPath = path.resolve(process.env.LOCI_PACKAGED_APP);
const kind = process.env.LOCI_REMOTE_QA_CASE;
assert.ok(['classical', 'cpu', 'gpu', 'cancel'].includes(kind));
const config = JSON.parse(await fs.readFile(process.env.LOCI_REMOTE_QA_CONFIG, 'utf8'));
assert.equal(config.source.license, 'CC0');
assert.match(config.source.dataset_url, /^https:\/\/bbbc\.broadinstitute\.org\/BBBC039/);
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT, kind);
await fs.mkdir(root, { recursive: true });
const attempt = new Date().toISOString().replaceAll(':', '-');
const output = path.join(root, attempt); await fs.mkdir(output);
const study = path.join(root, 'qualification.loci-study');
const knownHosts = path.join(root, 'known-hosts');
const hostFailureRecord = path.join(root, 'withheld-host.json');
let activeHosts = knownHosts;
if (await fs.stat(hostFailureRecord).catch(() => null)) activeHosts = JSON.parse(await fs.readFile(hostFailureRecord, 'utf8')).path;
assert.ok(activeHosts.startsWith(root + path.sep), 'Connection-error injection may only touch this case-owned host file');
const unavailableHosts = () => activeHosts + '.unavailable';
const python = process.env.LOCI_QA_PYTHON;
const sourceFile = path.resolve(config.source.path);
const helper = path.resolve(import.meta.dirname, '../../scripts/qa/compute-workbench.py');
const worker = path.join(appPath, 'Contents/Resources/loci-engine/loci-engine');
const executablePath = path.join(appPath, 'Contents/MacOS/Loci');
const hash = async file => { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); };
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(appPath, 'Contents/Resources/app.asar')), worker: await hash(worker) });
const cli = async (...args) => JSON.parse((await exec(worker, ['--loci', '--json', ...args], { timeout: 60000, maxBuffer: 8 * 1024 ** 2 })).stdout);
const receipt = { schema: 'loci.compute-workbench-qa/v1', status: 'running', case: kind,
  started_at: new Date().toISOString(), source: config.source, app: appPath, build: await identity(),
  background_window: process.env.LOCI_QA_BACKGROUND === '1',
  source_commit: process.env.LOCI_QA_SOURCE_COMMIT ?? null, script_sha256: await hash(import.meta.filename),
  oracle_sha256: await hash(helper), navigation_helper_sha256: await hash(path.join(import.meta.dirname, 'workbench-qa-helpers.mjs')),
  checks: [], transitions: [], screenshots: [] };
const persist = async () => fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
await persist();
const progress = async stage => { receipt.stage = stage; await persist(); console.log(`${kind}: ${stage}`); };
let app, page;
const rendererErrors = [];
const readRuns = () => page.evaluate(() => window.lociResearch.execute('remote_run_list', {})).then(value => value.runs);
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
async function wait(read, predicate, label, timeout = 30000, delay = 200) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  } while (true);
}
async function capture(name) {
  const file = `${name}.png`; await page.screenshot({ path: path.join(output, file) }); receipt.screenshots.push(file);
}
async function launch(name) {
  await progress(`Opening app (${name})`);
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(root, 'user-data')}`], timeout: 120000 });
  (receipt.launches ??= []).push({ name, at: new Date().toISOString() });
  page = await app.firstWindow(); page.on('pageerror', error => rendererErrors.push(error.message));
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await app.evaluate(({ dialog, BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 });
    dialog.showOpenDialog = async options => {
      if (options.title !== 'Open research study') throw new Error('Unexpected compute QA picker');
      return { canceled: false, filePaths: [target] };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  await page.getByRole('main', { name: 'Research workspace' })
    .or(page.getByRole('button', { name: 'Open study', exact: true })).first().waitFor();
  const current = await page.evaluate(() => window.lociResearch.getSnapshot());
  if (!current) await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  await progress(`Study open (${name})`);
}
async function quit() { await app.close(); app = null; page = null; }
async function openJobs() {
  if (!(await page.getByRole('region', { name: 'Job center', exact: true }).count()))
    await page.getByRole('button', { name: /^Jobs\s*\d*$/ }).click();
  await page.getByRole('region', { name: 'Job center', exact: true }).waitFor();
}
async function configure(profile) {
  await selectWorkbenchTool(page, 'Remote');
  for (const [label, key] of [
    ['Remote profile alias', 'alias'], ['Known host lookup', 'known_host'], ['Known hosts file', 'known_hosts_file'],
    ['Host key fingerprint', 'host_key_sha256'], ['Remote runtime Python', 'runtime_python'],
    ['Remote project root', 'remote_project_root'], ['Remote output root', 'remote_output_root'],
    ['Scheduler bin directory', 'scheduler_bin_dir'], ['SSH identity file', 'identity_file'],
    ['Scheduler queue', 'queue'], ['Scheduler account', 'account'], ['PBS GPU resource', 'pbs_gpu_resource'],
    ['Connect timeout seconds', 'connect_timeout_seconds'],
  ]) await page.getByLabel(label, { exact: true }).fill(String(profile[key] ?? ''));
  await page.getByLabel('Remote scheduler', { exact: true }).selectOption(profile.scheduler);
  await page.getByLabel('Permitted remote input roots', { exact: true }).fill(profile.remote_input_roots.join('\n'));
  for (const [label, key] of [['Remote CPUs', 'cpus'], ['Remote memory MiB', 'memory_mb'], ['Remote wall minutes', 'wall_minutes'], ['Remote GPUs', 'gpus']])
    await page.getByLabel(label, { exact: true }).fill(String(profile.resources[key]));
  await page.getByRole('button', { name: 'Save cluster profile', exact: true }).click();
  await page.getByLabel('Saved remote profile receipt', { exact: true }).waitFor();
  await progress('Checking the remote runtime');
  await page.getByRole('button', { name: 'Check worker readiness', exact: true }).click();
  await page.getByLabel('Saved remote profile receipt', { exact: true }).getByText(/readiness recorded/).waitFor({ timeout: 90000 });
  await capture('01-configured-target');
}
async function saveGlobalTarget(profile) {
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByRole('button', { name: 'Compute setup', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Compute', exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Save for all studies', exact: true }).click();
  await settings.getByRole('list', { name: 'Saved compute targets' }).getByText(profile.alias, { exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Add target', exact: true }).click();
  await settings.getByLabel('SSH alias', { exact: true }).fill(profile.alias);
  await settings.getByRole('button', { name: 'Import alias', exact: true }).click();
  await settings.getByText('Trusted host identity', { exact: true }).click();
  await settings.getByText(profile.host_key_sha256, { exact: true }).waitFor();
  await capture('01b-global-target-and-ssh-import');
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (kind === 'classical') {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 768 }));
    for (const theme of ['graphite', 'paper']) {
      await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await settings.getByLabel('Application theme', { exact: true }).selectOption(theme);
      await settings.getByRole('tab', { name: 'Compute', exact: true }).click();
      await settings.getByRole('list', { name: 'Saved compute targets' }).getByText(profile.alias, { exact: true }).waitFor();
      const layout = await settings.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
        documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width + 1 && layout.documentScroll <= layout.documentWidth + 1);
      await capture(`01c-global-target-${theme}`);
    }
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await settings.getByLabel('Application theme', { exact: true }).selectOption('graphite');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }));
  }
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  receipt.checks.push('Native Settings saves a study target application-wide and imports the existing trusted SSH alias without connecting or transferring an image');
}
async function bindHostFailureFixture() {
  const script = `import json,sqlite3,sys;from pathlib import Path
p=Path(sys.argv[1]);db=sqlite3.connect('file:'+str(p/'study.sqlite3')+'?mode=ro',uri=True)
rows=[json.loads(row[0]) for row in db.execute('SELECT record FROM documents WHERE kind=?',('policy',))]
runs=[row['data'] for row in rows if row['data'].get('schema')=='loci.remote-run-state/v1']
assert len(runs)==1
print(runs[0]['private_profile_snapshot']['private_profile']['known_hosts_file'])`;
  activeHosts = (await exec(python, ['-c', script, study])).stdout.trim();
  assert.ok(activeHosts.startsWith(root + path.sep));
  assert.equal((await fs.lstat(activeHosts)).isSymbolicLink(), false);
  await fs.writeFile(hostFailureRecord, JSON.stringify({ path: activeHosts }) + '\n');
}
async function openExistingStudy(target) {
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async options => {
      if (options.title !== 'Open research study') throw new Error('Unexpected compute QA picker');
      return { canceled: false, filePaths: [destination] };
    };
  }, target);
  await page.locator('.workbench-file-menu > summary').click();
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
}
async function oracle(result, parent = null, exported = null) {
  const args = [helper, '--project', study, '--source', sourceFile, '--result', result,
    '--expected-device', kind === 'classical' ? 'classical' : kind === 'gpu' ? 'cuda' : 'cpu'];
  if (parent) args.push('--parent', parent);
  if (exported) args.push('--export', exported);
  return JSON.parse((await exec(python, args, { timeout: 60000, maxBuffer: 8 * 1024 ** 2 })).stdout);
}

try {
  assert.equal(await hash(sourceFile), config.source.sha256);
  // Only this case's copied host file is withheld for the connection-error check.
  if (await fs.stat(unavailableHosts()).catch(() => null)) await fs.rename(unavailableHosts(), activeHosts);
  if (!(await fs.stat(knownHosts).catch(() => null))) await fs.copyFile(config.profile.known_hosts_file, knownHosts);
  await fs.chmod(knownHosts, 0o600);
  const profile = { ...config.profile, known_hosts_file: knownHosts,
    resources: { cpus: kind === 'cancel' ? 1 : 4, memory_mb: 16384, wall_minutes: 10, gpus: kind === 'gpu' ? 1 : 0 } };
  const boundConfig = { source: config.source, profile, case: kind };
  const configPath = path.join(root, 'case-config.json');
  if (await fs.stat(configPath).catch(() => null)) assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), boundConfig);
  else await fs.writeFile(configPath, JSON.stringify(boundConfig, null, 2) + '\n');
  if (!(await fs.stat(study).catch(() => null))) {
    await cli('create', '--project', study, '--title', `Public Vanda ${kind} qualification`);
    await cli('import', '--project', study, sourceFile);
  }
  await launch('initial');
  const initial = await snapshot(); assert.equal(initial.sources.length, 1);
  const source = initial.sources[0]; assert.equal(source.sha256, config.source.sha256);
  assert.equal(source.metadata.physical_calibration, null, 'This fixture declares print density, not specimen spacing');
  receipt.source_id = source.id; receipt.project_id = initial.project.project_id;
  let runs = await readRuns(); assert.ok(runs.length <= 1, 'Each case permits exactly one intentional remote run');
  receipt.resumed_existing_run = runs.length === 1;
  if (receipt.resumed_existing_run) {
    receipt.prior_attempt_receipts = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const previous = path.join(root, entry.name, 'receipt.json');
      if (!entry.isDirectory() || path.dirname(previous) === output) continue;
      const earlier = await fs.readFile(previous, 'utf8').then(JSON.parse).catch(() => null);
      if (earlier?.request_key === runs[0].request_key)
        receipt.prior_attempt_receipts.push(path.relative(root, previous));
    }
  }
  if (!runs.length) {
    const profiles = await page.evaluate(() => window.lociResearch.execute('remote_profile_list', {}));
    if (!profiles.profiles.length) await configure(profile);
    else {
      assert.equal(profiles.profiles.length, 1); assert.equal(profiles.profiles[0].alias, profile.alias);
      assert.deepEqual(profiles.profiles[0].resources, profile.resources);
    }
    const saved = await page.evaluate(() => window.lociResearch.computeTargets('list', {}));
    if (!saved.targets.length) await saveGlobalTarget(profile);
    else { assert.equal(saved.targets.length, 1); assert.deepEqual(saved.targets[0].resources, profile.resources); }
    await selectWorkbenchTool(page, 'Display');
    const extent = kind === 'cancel' ? 512 : 256;
    for (const [label, value] of [['X', 0], ['Y', 0], ['Width', extent], ['Height', extent], ['C', 0]]) await setSelectionField(page, label, value);
    await selectWorkbenchTool(page, 'Analyze');
    await page.getByLabel('Segmentation model', { exact: true }).selectOption(kind === 'classical' ? 'classical' : 'cellpose-sam');
    await page.getByLabel('Run on', { exact: true }).focus();
    await page.getByLabel('Run on', { exact: true }).selectOption(profile.alias);
    if (kind === 'classical') {
      await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
      await page.getByLabel('Threshold', { exact: true }).fill('1000');
      await page.getByLabel('Minimum object measure', { exact: true }).fill('0');
      await page.getByLabel('Minimum object measure', { exact: true }).press('Tab');
    }
    await capture('02-normal-analysis-target');
    const control = page.getByLabel('Analysis compute target', { exact: true });
    assert.match(await control.innerText(), /source|\.tif/);
    assert.match(await control.innerText(), /in full/);
    const [computeBounds, modelBounds] = await Promise.all([
      control.boundingBox(), page.getByLabel('Segmentation model', { exact: true }).boundingBox(),
    ]);
    assert.ok(Math.abs(computeBounds.x - modelBounds.x) <= 1 && Math.abs(computeBounds.width - modelBounds.width) <= 1,
      'Compute choices must align with the surrounding analysis controls');
    await page.getByRole('button', { name: kind === 'classical' ? 'Run recipe' : `Segment on ${profile.alias}`, exact: true }).click();
    await progress('Waiting for the one submitted remote identity');
    runs = await wait(readRuns, values => values.length === 1 && values[0].remote_job_id, 'One submitted remote identity', 120000, 500);
  }
  let run = runs[0]; assert.ok(run.automatic); assert.equal(run.alias, profile.alias); assert.deepEqual(run.source_ids, [source.id]);
  receipt.request_key = run.request_key; receipt.initial_run = run; await persist();
  console.log(`${kind}: saved remote job ${run.remote_job_id}, request ${run.request_key}, state ${run.state}`);
  await openJobs(); await capture('03-job-center');
  const jobLabel = await page.getByRole('list', { name: 'Remote analysis jobs' }).locator('strong').evaluate(element => ({
    text: element.textContent, width: element.clientWidth, fullWidth: element.scrollWidth,
  }));
  assert.equal(jobLabel.text, `${profile.alias} · 1 analysis task`);
  assert.ok(jobLabel.width > 0 && jobLabel.fullWidth <= jobLabel.width, 'The remote job label must be readable without clipping');
  if (kind === 'cancel') {
    assert.ok(!['attached', 'cleaned', 'finished', 'retrieved'].includes(run.state), 'Cancellation fixture finished before cancellation could be exercised');
    if (!run.cancel_requested) await page.getByRole('list', { name: 'Remote analysis jobs' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    run = (await wait(readRuns, values => values[0]?.cancel_requested, 'Durable cancellation', 60000))[0];
    const cancelled = (await wait(readRuns, values => values[0]?.state === 'cancelled', 'Automatic scheduler cancellation confirmation', 60000, 1000))[0];
    assert.equal(cancelled.remote_state, 'failed', 'The real scheduler must confirm termination, not a completed successful job');
    await page.getByRole('list', { name: 'Remote analysis jobs' }).getByText('Cancelled', { exact: true }).waitFor();
    assert.equal((await snapshot()).results.length, 0); receipt.cancelled_run = cancelled;
    await capture('04-cancelled-job'); receipt.checks.push(receipt.resumed_existing_run
      ? 'Reopened the same confirmed cancelled scheduler job with no published result; original cancellation is linked in prior attempt receipts'
      : 'Native Job Center cancellation reached the owned scheduler job and published no result');
  } else {
    if (kind === 'cpu' && !['retrieved', 'attached', 'cleaned'].includes(run.state)) {
      await bindHostFailureFixture();
      await fs.rename(activeHosts, unavailableHosts());
      await page.getByRole('list', { name: 'Remote analysis jobs' }).locator('.workbench-jobs__error').waitFor({ timeout: 45000 });
      const unavailable = (await readRuns())[0]; assert.notEqual(unavailable.state, 'failed');
      await capture('04-connection-unavailable'); receipt.checks.push('Withholding this case-owned host file makes the connection unavailable without declaring job failure');
    }
    await quit();
    if (await fs.stat(unavailableHosts()).catch(() => null)) await fs.rename(unavailableHosts(), activeHosts);
    await launch('recovery'); await openJobs();
    let previous = null;
    run = (await wait(readRuns, values => {
      assert.equal(values.length, 1); assert.equal(values[0].request_key, receipt.request_key);
      const current = values[0];
      if (current.state !== previous) {
        previous = current.state; receipt.transitions.push({ at: new Date().toISOString(), state: current.state, remote_state: current.remote_state });
        console.log(`${kind}: ${current.state}`);
      }
      assert.notEqual(current.state, 'failed', JSON.stringify(current));
      return current.state === 'attached';
    }, 'Automatic retrieval and attachment after app restart', 15 * 60 * 1000, 3000))[0];
    assert.equal(run.remote_job_id, receipt.initial_run.remote_job_id);
    assert.ok(run.app_target?.id && Number.isInteger(run.app_target.revision));
    const saved = await page.evaluate(() => window.lociResearch.computeTargets('list', {}));
    assert.equal(saved.targets.length, 1); assert.equal(saved.targets[0].id, run.app_target.id);
    assert.equal(run.attachment.task_results.length, 1); receipt.completed_run = run;
    const parentId = run.attachment.task_results[0].local_result_id;
    receipt.parent_oracle = await oracle(parentId);
    await page.locator(`.research-sources [data-result-id="${parentId}"]`).click();
    await selectWorkbenchTool(page, 'Info'); await capture('05-attached-result');
    receipt.checks.push(receipt.resumed_existing_run
      ? 'Reopened the existing remote job and verified its single attachment without another submission'
      : 'Normal Analyze starts one remote run; cold app restart recovers the same job, retrieves and attaches once',
    'Independent result-image reconstruction and raw-source measurement arithmetic match the current remote result');
    if (kind === 'classical') {
      if (Object.entries(profile.resources).some(([key, value]) => saved.targets[0].resources[key] !== value)) {
        assert.ok(receipt.resumed_existing_run, 'Only a resumed fixture may start with its future resource edit already saved');
        await selectWorkbenchTool(page, 'Analyze');
        await page.getByRole('button', { name: 'Compute setup', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'Resources', exact: true }).click();
        await settings.getByLabel('Resource preset', { exact: true }).selectOption('cpu');
        await settings.getByLabel('CPU cores', { exact: true }).fill(String(profile.resources.cpus));
        await settings.getByLabel('Host RAM (GiB)', { exact: true }).fill(String(profile.resources.memory_mb / 1024));
        await settings.getByLabel('Time limit (min)', { exact: true }).fill('10');
        await settings.getByRole('button', { name: 'Save resources', exact: true }).click();
        await settings.getByText('Resources saved for future runs.', { exact: true }).waitFor();
        const restored = await page.evaluate(() => window.lociResearch.computeTargets('list', {}));
        assert.equal(restored.targets.length, 1);
        assert.equal(restored.targets[0].id, saved.targets[0].id);
        assert.deepEqual(restored.targets[0].resources, profile.resources);
        await settings.getByRole('button', { name: 'Done', exact: true }).click();
        receipt.checks.push('Resuming the same completed case restores only its case-owned future CPU resources before repeating the edit check');
      }
      const other = path.join(root, 'second-study.loci-study');
      if (!(await fs.stat(other).catch(() => null))) {
        await cli('create', '--project', other, '--title', 'Compute target reuse fixture');
        await cli('import', '--project', other, sourceFile);
      }
      await openExistingStudy(other);
      await wait(snapshot, value => value?.project.project_id !== receipt.project_id && value?.sources.length === 1, 'Second study opened');
      await selectWorkbenchTool(page, 'Analyze');
      await page.getByLabel('Run on', { exact: true }).focus();
      await page.getByLabel('Run on', { exact: true }).selectOption(profile.alias);
      assert.equal((await page.evaluate(() => window.lociResearch.execute('remote_profile_list', {}))).profiles.length, 0);
      assert.equal((await readRuns()).length, 0);
      await capture('05b-global-target-second-study');
      await openExistingStudy(study);
      await wait(snapshot, value => value?.project.project_id === receipt.project_id, 'Original study restored');
      assert.equal((await readRuns()).length, 1);
      receipt.checks.push('A second study offers the application target without copying a study profile or starting a run until Run is clicked');
      await selectWorkbenchTool(page, 'Analyze');
      await page.getByLabel('Run on', { exact: true }).focus();
      await page.getByLabel('Run on', { exact: true }).selectOption(profile.alias);
      await page.getByRole('button', { name: 'Compute setup', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('button', { name: 'Resources', exact: true }).click();
      await settings.getByLabel('Resource preset', { exact: true }).selectOption('gpu');
      await settings.getByLabel('Time limit (min)', { exact: true }).fill('10');
      await settings.getByRole('button', { name: 'Save resources', exact: true }).click();
      await settings.getByText('Resources saved for future runs.', { exact: true }).waitFor();
      const changed = await page.evaluate(() => window.lociResearch.computeTargets('list', {}));
      assert.equal(changed.targets[0].id, saved.targets[0].id);
      assert.ok(changed.targets[0].revision > saved.targets[0].revision);
      assert.deepEqual(changed.targets[0].resources, { ...profile.resources, gpus: 1 });
      await capture('05c-future-resource-preset');
      await settings.getByRole('button', { name: 'Done', exact: true }).click();
      const retained = (await readRuns())[0];
      assert.equal(retained.remote_job_id, run.remote_job_id);
      assert.deepEqual(retained.resources, profile.resources);
      assert.deepEqual(retained.app_target, run.app_target);
      assert.deepEqual(await oracle(parentId), receipt.parent_oracle);
      receipt.checks.push('Changing the saved target to Single GPU leaves the completed CPU job, bound target revision and numerical result unchanged');
      await page.getByLabel('Run on', { exact: true }).focus();
      const gpuOption = page.getByRole('option', { name: `${profile.alias} · 1 GPU`, exact: true });
      // Playwright's isDisabled follows this option's enclosing label to the
      // enabled select. Inspect the actual native option instead.
      receipt.classical_gpu_option = await wait(() => gpuOption.evaluate(option => ({
        tag: option.tagName, disabled: option instanceof HTMLOptionElement && option.disabled,
        disabled_attribute: option.hasAttribute('disabled'),
        parent_select_disabled: option.closest('select')?.disabled,
      })), value => value.tag === 'OPTION' && value.disabled && value.disabled_attribute,
      'Updated GPU resources are unavailable to classical analysis');
      receipt.classical_gpu_option.playwright_is_disabled = await gpuOption.isDisabled();
      await page.getByRole('button', { name: 'Run recipe', exact: true }).click();
      await page.getByText('Choose CPU resources for a classical analysis.', { exact: true }).first().waitFor();
      assert.equal((await readRuns()).length, 1, 'An incompatible resource change must not create another job');
      await capture('05d-classical-gpu-refused');
      receipt.checks.push('A selected target changed to GPU resources is refused for classical analysis before another run is created');
    }
    if (kind === 'gpu') {
      const before = (await snapshot()).results;
      let child = before.find(item => item.parent_id === parentId);
      if (!child) {
        await selectWorkbenchTool(page, 'Correction');
        const labels = page.getByLabel('Correction label', { exact: true });
        await labels.selectOption('1');
        await page.getByRole('button', { name: 'Delete selected label', exact: true }).click();
        const state = await wait(snapshot, value => value.results.some(item => item.parent_id === parentId), 'Remote result correction child');
        child = state.results.find(item => item.parent_id === parentId);
      }
      assert.equal((await snapshot()).results.filter(item => item.parent_id === parentId).length, 1);
      receipt.child_oracle = await oracle(child.id, parentId);
      assert.deepEqual(await oracle(parentId), receipt.parent_oracle, 'The remote parent must remain immutable');
      await page.locator(`.research-sources [data-result-id="${child.id}"]`).click();
      await selectWorkbenchTool(page, 'Info');
      if (child.review === null) await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
      else {
        assert.equal(child.review.actor, 'human'); assert.equal(child.review.disposition, 'reviewed');
        assert.equal(child.review.revision_hash, child.revision_hash);
      }
      await page.getByRole('status').filter({ hasText: 'Reviewed by researcher' }).waitFor();
      const exportPath = path.join(output, 'reviewed-gpu-correction');
      await app.evaluate(({ dialog }, destination) => {
        dialog.showSaveDialog = async options => {
          if (options.title !== 'Export reviewed result bundle') throw new Error('Unexpected result export picker');
          return { canceled: false, filePath: destination };
        };
      }, exportPath);
      await page.getByRole('button', { name: 'Export result', exact: true }).click();
      await wait(() => fs.stat(path.join(exportPath, 'manifest.json')).catch(() => null), value => value?.size > 0, 'Atomic corrected export');
      receipt.export_oracle = await oracle(child.id, parentId, exportPath); await capture('06-corrected-reviewed-exported');
      await quit(); await launch('final-reopen');
      const reopened = await snapshot(); assert.equal(reopened.results.find(item => item.id === child.id).revision_hash, child.revision_hash);
      assert.equal(reopened.results.find(item => item.id === child.id).review.actor, 'human');
      assert.deepEqual(await oracle(child.id, parentId, exportPath), receipt.export_oracle);
      assert.equal((await readRuns()).length, 1);
      await page.locator(`.research-sources [data-result-id="${child.id}"]`).click(); await selectWorkbenchTool(page, 'Info'); await capture('07-final-reopen');
      receipt.checks.push('Native correction, researcher-UI technical review, export and second cold reopen preserve the remote identities, exact arrays, measurements and immutable parent');
    }
  }
  assert.deepEqual(rendererErrors, []); assert.equal(await hash(sourceFile), config.source.sha256); assert.deepEqual(await identity(), receipt.build);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = error.stack;
  if (page) { await capture('failure').catch(() => {}); receipt.last_runs = await readRuns().catch(() => null); }
  console.error(error);
} finally {
  if (await fs.stat(unavailableHosts()).catch(() => null)) await fs.rename(unavailableHosts(), activeHosts);
  if (app) await quit().catch(error => { receipt.status = 'failed'; receipt.cleanup_error = error.stack; });
  receipt.renderer_errors = rendererErrors; receipt.finished_at = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ status: receipt.status, receipt: path.join(output, 'receipt.json') }));
}
if (receipt.status !== 'passed') process.exitCode = 1;
