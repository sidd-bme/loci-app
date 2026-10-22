/** Native, synthetic-only packaged macOS assistant/display/vision qualification.
 * Run from desktop with Node 24, LOCI_PACKAGED_APP, LOCI_QA_PYTHON and optionally
 * LOCI_QA_OUTPUT_ROOT / LOCI_QA_SOURCE_COMMIT. No existing study or image is read.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { selectResultSection, selectWorkbenchTool, setSelectionField } from './workbench-qa-helpers.mjs';

const exec = promisify(execFile);
const appPath = process.env.LOCI_PACKAGED_APP ? path.resolve(process.env.LOCI_PACKAGED_APP) : null;
const python = process.env.LOCI_QA_PYTHON;
assert.ok(appPath && python, 'Set LOCI_PACKAGED_APP and LOCI_QA_PYTHON (canonical engine .venv Python)');
assert.equal(process.platform, 'darwin', 'This journey qualifies the supported macOS package only');
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? '../.loci/evidence/qa/agent-workbench');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'run-'));
const helper = path.resolve(import.meta.dirname, '../../scripts/qa/agent-workbench-client.py');
const worker = path.join(appPath, 'Contents/Resources/loci-engine/loci-engine');
const executablePath = path.join(appPath, 'Contents/MacOS/Loci');
const study = path.join(output, 'synthetic.loci-study');
const access = path.join(output, 'access');
const exports = path.join(output, 'exports');
await fs.mkdir(exports);
const hash = async (file) => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(appPath, 'Contents/Resources/app.asar')), worker: await hash(worker) });
const receipt = { status: 'running', started_at: new Date().toISOString(), app: appPath,
  background_window: process.env.LOCI_QA_BACKGROUND === '1',
  source_commit: process.env.LOCI_QA_SOURCE_COMMIT ?? null, build: await identity(),
  script_sha256: await hash(import.meta.filename), helper_sha256: await hash(helper),
  navigation_helper_sha256: await hash(path.join(import.meta.dirname, 'workbench-qa-helpers.mjs')),
  checks: [], calls: [], exports: [], screenshots: [] };
const cli = async (...args) => JSON.parse((await exec(worker, ['--loci', '--json', ...args], { timeout: 30000, maxBuffer: 4 * 1024 ** 2 })).stdout);
let app, client;
const rendererErrors = [];

function sdkClient(policy) {
  const child = spawn(python, [helper, 'serve', worker, policy], { stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = []; let failure = null, diagnostic = '';
  child.stderr.on('data', (data) => { diagnostic += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const pending = queue.shift();
    if (!pending) { failure = new Error(`Unexpected SDK controller output: ${line}`); return; }
    clearTimeout(pending.timer);
    try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
  });
  const closed = new Promise((resolve) => child.once('exit', (code, signal) => {
    failure = new Error(`SDK controller exited (${code ?? signal}): ${diagnostic}`);
    for (const pending of queue.splice(0)) { clearTimeout(pending.timer); pending.reject(failure); }
    resolve({ code, signal });
  }));
  child.on('error', (error) => { failure = error; for (const pending of queue.splice(0)) { clearTimeout(pending.timer); pending.reject(error); } });
  const receive = () => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const timer = setTimeout(() => { reject(new Error('SDK controller response exceeded 45 seconds')); child.kill(); }, 45000);
    queue.push({ resolve, reject, timer });
  });
  const ready = receive();
  return { ready, call: async (name, args, expectedError = false) => {
    const pending = receive(); child.stdin.write(JSON.stringify({ name, arguments: args }) + '\n');
    const result = await pending;
    receipt.calls.push({ name, expected_error: expectedError, ...result });
    assert.equal(result.is_error, expectedError, `${name}: ${JSON.stringify(result)}`);
    return result;
  }, tools: async () => { const pending = receive(); child.stdin.write('{"action":"tools"}\n'); return pending; },
  close: async () => {
    child.stdin.end(); let timer;
    try {
      const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('SDK controller did not close')); }, 10000); })]);
      assert.equal(result.code, 0);
    } finally { clearTimeout(timer); await fs.writeFile(path.join(output, 'mcp-stderr.log'), diagnostic); }
  } };
}
const nativeImage = (result) => {
  const images = result.content.filter((block) => block.type === 'image');
  assert.ok(images.length > 0, 'Actual MCP native ImageContent is required');
  for (const image of images) { assert.equal(image.mimeType, 'image/png'); assert.equal(image.png_signature, true); assert.ok(image.size_bytes > 0); assert.match(image.sha256, /^[a-f0-9]{64}$/); }
  assert.equal(Object.hasOwn(result.structured_content ?? {}, 'image'), false);
  assert.doesNotMatch(JSON.stringify(result.structured_content), /base64|data:image/);
  for (const block of result.content.filter((item) => item.type === 'text')) assert.doesNotMatch(block.text, /data:image/);
};
const verifyHandoff = async (directory, source, artifacts = null) => {
  assert.deepEqual((await fs.readdir(directory)).sort(), ['README.md', 'context.json', 'image.png', 'manifest.json']);
  const context = await json(path.join(directory, 'context.json'));
  const manifest = await json(path.join(directory, 'manifest.json'));
  assert.equal(context.status, 'provisional-visualization'); assert.equal(context.scientific_validation, 'not established');
  assert.equal(context.source_id, source.id); assert.equal(context.source_sha256, source.sha256);
  assert.equal(manifest.schema, 'loci.vision-handoff/v1');
  assert.equal(Object.hasOwn(context, 'review'), false);
  assert.equal(Object.hasOwn(context, 'review_status'), false);
  assert.doesNotMatch(JSON.stringify(context), new RegExp(output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const hashes = {};
  for (const file of ['image.png', 'context.json', 'README.md', 'manifest.json']) {
    hashes[file] = await hash(path.join(directory, file));
    const expected = file === 'manifest.json' ? artifacts?.[file] : manifest.artifacts[file];
    if (expected) { assert.equal(hashes[file], expected.sha256); assert.equal((await fs.stat(path.join(directory, file))).size, expected.size_bytes); }
  }
  const png = await fs.readFile(path.join(directory, 'image.png')); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  receipt.exports.push({ basename: path.basename(directory), hashes, context });
};
try {
  const fixture = JSON.parse((await exec(python, [helper, 'fixture', output], { timeout: 30000 })).stdout);
  assert.equal(path.dirname(fixture.source), output); assert.equal(await hash(fixture.source), fixture.sha256);
  receipt.fixture = fixture;
  await cli('create', '--project', study, '--title', 'Synthetic assistant qualification');
  const imported = await cli('import', '--project', study, fixture.source);
  assert.equal(imported.sources.length, 1);
  const source = imported.sources[0]; assert.equal(source.sha256, fixture.sha256); assert.equal(source.metadata.dimensions.c, 2);
  receipt.source = { id: source.id, sha256: source.sha256 };
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(output, 'user-data')}`], timeout: 120000 });
  const page = await app.firstWindow(); page.on('pageerror', (error) => rendererErrors.push(error.message));
  await app.evaluate(({ dialog, BrowserWindow }, studyPath) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [studyPath] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  if (receipt.background_window) await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  const view = () => page.evaluate((id) => window.lociResearch.execute('source_view', { source_id: id }), source.id);
  await selectWorkbenchTool(page, 'Display');
  await page.evaluate(() => {
    window.__qaRegionEvents = [];
    for (const kind of ['keydown', 'beforeinput', 'input', 'blur']) {
      document.addEventListener(kind, event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.closest('.analysis-region-settings')) return;
        window.__qaRegionEvents.push({ type: kind, label: input.getAttribute('aria-label'),
          value: input.value, key: event.key ?? null, data: event.data ?? null,
          inputType: event.inputType ?? null, trusted: event.isTrusted });
      }, true);
    }
  });
  receipt.selection_edit_trace = [];
  for (const [label, key] of [['Width', 'width'], ['Height', 'height'], ['X', 'x'], ['Y', 'y'], ['C', 'c']]) {
    await setSelectionField(page, label, fixture.selection[key]);
    const fields = await page.locator('.analysis-region-settings input').evaluateAll(inputs =>
      inputs.map(input => ({ label: input.getAttribute('aria-label'), value: input.value,
        invalid: input.getAttribute('aria-invalid'), hint: input.getAttribute('aria-description') })),
    );
    receipt.selection_edit_trace.push({ edited: label, fields });
    receipt.selection_input_events = await page.evaluate(() => window.__qaRegionEvents);
    const edited = fields.find(field => field.label === label);
    assert.equal(edited?.invalid, 'false', `The ${label} edit must be accepted before granting access`);
    assert.equal(Number(edited?.value), fixture.selection[key]);
  }
  await selectWorkbenchTool(page, 'Analyze');
  await page.getByLabel('Segmentation model', { exact: true }).selectOption('classical');
  await page.getByLabel('Segmentation method', { exact: true }).selectOption('components');
  await page.getByLabel('Threshold', { exact: true }).fill('50');
  await page.getByLabel('Minimum object measure', { exact: true }).fill('1');
  await page.getByLabel('Minimum object measure', { exact: true }).press('Tab');
  await selectWorkbenchTool(page, 'Agent');
  const panel = page.locator('.research-agent');
  await panel.getByText('Customize permissions', { exact: true }).click();
  const grant = panel.getByRole('button', { name: `Grant selected access to ${source.name}`, exact: true });
  assert.equal(await grant.isEnabled(), false);
  for (const checkbox of await panel.getByRole('checkbox').all()) assert.equal(await checkbox.isChecked(), false, 'All grants/disclosures start denied');
  const pre = panel.getByText('Displayed recipe settings', { exact: true }); await pre.click();
  const displayedRecipe = JSON.parse(await panel.locator('pre').innerText());
  assert.equal(displayedRecipe.segmentation.threshold, 50); assert.equal(displayedRecipe.segmentation.min_size, 1);
  await panel.getByRole('button', { name: 'Validate exact scope and recipe', exact: true }).click();
  await panel.getByLabel('Exact recipe validation', { exact: true }).waitFor();
  const configureScope = async (checkContextGate = false) => {
    const custom = panel.locator('details.research-agent-custom');
    if (!(await custom.evaluate(element => element.open))) await custom.locator(':scope > summary').click();
    for (const label of ['Allow display-only recipe previews', 'Allow durable recipe runs and result reads', 'Allow exact reviewed-result export', 'Allow source images for vision analysis', 'Allow reversible channel display changes', 'Allow local vision handoff export', 'Allow bounded recipe exploration']) await panel.getByLabel(label, { exact: true }).check();
    await panel.getByLabel('Grant display channel 1', { exact: true }).check();
    assert.equal(await panel.getByLabel('Grant display channel 2', { exact: true }).isChecked(), false);
    await panel.getByLabel('Exact vision handoff names', { exact: true }).fill('assistant.loci-vision');
    await panel.getByLabel('Exact export names', { exact: true }).fill('reviewed-result');
    for (const [label, value] of [['Threshold minimum', '40'], ['Threshold maximum', '90'], ['Minimum size lower bound', '0'], ['Minimum size upper bound', '20']]) await panel.getByLabel(label, { exact: true }).fill(value);
    for (const category of ['geometry', 'source_names', 'previews', 'measurements', 'provenance']) await panel.getByLabel(`Disclose ${category}`, { exact: true }).check();
    if (checkContextGate) assert.equal(await grant.isEnabled(), false, 'Analysis-context disclosure is independent and required');
    await panel.getByLabel('Disclose agent_metadata', { exact: true }).check();
    await panel.getByLabel('Agent CPU seconds', { exact: true }).fill('120');
    await panel.getByLabel('Agent memory MiB', { exact: true }).fill('1024');
  };
  await configureScope(true);
  assert.equal(await grant.isEnabled(), true);
  await page.screenshot({ path: path.join(output, '01-native-access-form.png') }); receipt.screenshots.push('01-native-access-form.png');
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (options) => { if (options.title !== 'Choose the permitted agent export folder') throw new Error('Unexpected open picker'); return { canceled: false, filePaths: [paths.exports] }; };
    dialog.showSaveDialog = async (options) => { if (options.title !== 'Create private MCP access bundle') throw new Error('Unexpected access save picker'); return { canceled: false, filePath: paths.access }; };
  }, { exports, access });
  await grant.click(); await panel.getByLabel('Created agent access receipt', { exact: true }).waitFor();
  const policyPath = path.join(access, 'agent-policy.json'); const policy = await json(policyPath);
  assert.equal(policy.schema, 'loci.agent-policy/v3'); assert.deepEqual(policy.sources[0].c, [0]);
  assert.deepEqual(policy.sources[0].crop, Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, fixture.selection[key]])));
  assert.equal(policy.experimental_recipes.length, 1);
  assert.deepEqual(policy.experimental_recipes[0].parameters, { threshold: { min: 40, max: 90 }, min_size: { min: 0, max: 20 } });
  const approved = await json(path.join(access, 'approved-request.json'));
  assert.deepEqual(approved.recipe, policy.experimental_recipes[0].recipe);
  const plugin = await json(path.join(access, 'plugin/plugin.json'));
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'); assert.equal(plugin.name, 'loci-analysis'); assert.equal(plugin.license, 'Apache-2.0'); assert.ok(plugin.extensions['com.openai'].interface);
  const pluginServer = (await json(path.join(access, 'plugin/mcp.json'))).mcpServers['loci-research'];
  assert.equal(pluginServer.type, 'stdio'); assert.equal(pluginServer.command, worker); assert.deepEqual(pluginServer.args, ['--cli', 'mcp', '--policy', policyPath]);
  assert.equal(Object.hasOwn(pluginServer, 'cwd'), false); assert.equal(Object.hasOwn(pluginServer, 'env'), false);
  const marketplace = await json(path.join(access, '.agents/plugins/marketplace.json'));
  assert.equal(marketplace.name, `loci-local-${(await hash(policyPath)).slice(0, 12)}`);
  assert.deepEqual(marketplace.plugins[0].source, { source: 'local', path: './plugin' }); assert.deepEqual(marketplace.plugins[0].policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.match(await fs.readFile(path.join(access, 'plugin/skills/loci-analysis/SKILL.md'), 'utf8'), /Without this grant, leave\s+approval to the researcher/);
  receipt.policy_sha256 = await hash(policyPath); receipt.checks.push('native-v3-policy-plugin-and-ranges');
  client = sdkClient(policyPath); assert.equal((await client.ready).ready, true);
  const tools = (await client.tools()).tools;
  for (const name of ['source_image', 'source_display', 'set_source_display', 'preview_recipe', 'submit_recipe', 'export_vision_handoff', 'export_result']) assert.ok(tools.includes(name));
  assert.equal(tools.includes('review'), false);
  const display = (await client.call('source_display', { source_id: source.id })).structured_content;
  const imageRequest = { source_id: source.id, selection: { ...fixture.selection }, channels: [{ ...display.channels[0], low: 0, high: 200, visible: true }], projection: 'plane', max_size: 64 };
  nativeImage(await client.call('source_image', { request: imageRequest }));
  const basePreviewBefore = await client.call('preview_recipe', { request: approved }); nativeImage(basePreviewBefore);
  assert.equal(basePreviewBefore.structured_content.object_count, fixture.expected_objects);
  await selectWorkbenchTool(page, 'Agent');
  const vision = page.getByRole('region', { name: 'Vision assistant tools', exact: true });
  await vision.getByLabel('Follow assistant display', { exact: true }).check();
  await page.waitForFunction(() => { const box = document.querySelector('.source-agent-controls input[type="checkbox"]'); return box?.checked && !box.disabled; });
  await selectWorkbenchTool(page, 'Display');
  await page.waitForFunction(() => document.querySelector('fieldset.source-display-local')?.disabled === true);
  const channelColors = page.getByLabel('Channel 1 color', { exact: true });
  assert.equal(await channelColors.count(), 2, 'Compact and detailed channel controls are both present');
  for (const control of await channelColors.all()) assert.equal(await control.isDisabled(), true);
  const savedBefore = await view();
  const changed = (await client.call('set_source_display', { source_id: source.id, source_sha256: source.sha256, expected_revision: savedBefore.revision, channels: [{ ...imageRequest.channels[0], color: '#ff00aa' }] })).structured_content;
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Channel 1 color"]')].length === 2 && [...document.querySelectorAll('[aria-label="Channel 1 color"]')].every((input) => input.value === '#ff00aa'));
  await page.waitForTimeout(1600); // More than one follower poll and the local autosave debounce.
  const adopted = await view(); assert.equal(adopted.revision, changed.revision); assert.equal(adopted.state.channels[0].color, '#ff00aa');
  assert.deepEqual(adopted.state.selection, savedBefore.state.selection); assert.deepEqual(adopted.state.camera, savedBefore.state.camera); assert.deepEqual(adopted.state.channels[1], savedBefore.state.channels[1]);
  await client.call('set_source_display', { source_id: source.id, source_sha256: source.sha256, expected_revision: savedBefore.revision, channels: imageRequest.channels }, true);
  assert.deepEqual(await view(), adopted, 'A rejected stale display write must preserve the saved revision and state');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('fieldset.source-display-local')?.disabled === false);
  for (const control of await channelColors.all()) assert.equal(await control.isEnabled(), true);
  const color = page.locator('fieldset.source-display-local').getByLabel('Channel 1 color', { exact: true }); await color.locator('..').locator('..').locator('..').evaluate((element) => { if (element.tagName === 'DETAILS') element.open = true; });
  await color.fill('#00aaff');
  let local;
  const saveDeadline = Date.now() + 10000;
  do {
    local = await view();
    if (local.state?.channels[0].color === '#00aaff') break;
    assert.ok(Date.now() < saveDeadline, 'The local channel edit did not reach saved source state');
    await page.waitForTimeout(50);
  } while (true);
  assert.equal(local.revision, changed.revision + 1); receipt.checks.push('external-mcp-follow-cas-and-local-next-revision');
  const basePreviewAfter = await client.call('preview_recipe', { request: approved }); nativeImage(basePreviewAfter);
  assert.deepEqual(basePreviewAfter.structured_content.measurements, basePreviewBefore.structured_content.measurements);
  assert.equal(basePreviewAfter.structured_content.provenance.recipe_sha256, basePreviewBefore.structured_content.provenance.recipe_sha256);
  receipt.checks.push('display-preserves-numerical-preview');
  const badSelectionChannel = structuredClone(imageRequest); badSelectionChannel.selection.c = 1;
  await client.call('source_image', { request: badSelectionChannel }, true);
  await client.call('set_source_display', { source_id: source.id, source_sha256: source.sha256, expected_revision: local.revision, channels: [{ ...imageRequest.channels[0], channel: 1 }] }, true);
  const badChannel = structuredClone(imageRequest); badChannel.channels[0].channel = 1;
  await client.call('source_image', { request: badChannel }, true);
  const badRegion = structuredClone(imageRequest); badRegion.selection.x = 0;
  await client.call('source_image', { request: badRegion }, true);
  const ranged = structuredClone(approved); ranged.recipe.segmentation.threshold = 75; ranged.recipe.segmentation.min_size = 2;
  const validation = (await client.call('validate_recipe', { request: ranged })).structured_content;
  assert.deepEqual(validation.approved, { preview: true, run: true });
  nativeImage(await client.call('preview_recipe', { request: ranged }));
  const outside = structuredClone(ranged); outside.recipe.segmentation.threshold = 91;
  const invalid = (await client.call('validate_recipe', { request: outside })).structured_content;
  assert.deepEqual(invalid.approved, { preview: false, run: false });
  await client.call('preview_recipe', { request: outside }, true);
  const outsideSize = structuredClone(ranged); outsideSize.recipe.segmentation.min_size = 21;
  assert.deepEqual((await client.call('validate_recipe', { request: outsideSize })).structured_content.approved, { preview: false, run: false });
  await client.call('preview_recipe', { request: outsideSize }, true);
  const submitted = (await client.call('submit_recipe', { request: ranged, request_key: 'agent-workbench-range' })).structured_content;
  let job;
  const deadline = Date.now() + 30000;
  do { job = (await client.call('job_status', { job_id: submitted.job.id })).structured_content.job; if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state) || job.owned_worker_active) await page.waitForTimeout(100); assert.ok(Date.now() < deadline, 'Durable MCP job exceeded its bounded fixture deadline'); } while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state) || job.owned_worker_active);
  assert.equal(job.state, 'succeeded'); assert.equal(job.owned_worker_active, false); assert.equal(job.result_ids.length, 1);
  const result = (await client.call('result', { result_id: job.result_ids[0] })).structured_content;
  assert.equal(result.total_rows, fixture.expected_objects); assert.equal(result.measurements.length, fixture.expected_objects); assert.equal(result.result.review, null);
  await client.call('export_result', { result_id: result.result.id, revision_hash: result.result.revision_hash, filename: 'reviewed-result' }, true);
  assert.equal((await fs.readdir(exports)).includes('reviewed-result'), false);
  receipt.checks.push('native-mcp-images-preview-range-run-and-human-review-gate', 'scope-and-parameter-rejections');
  const handoff = (await client.call('export_vision_handoff', { request: imageRequest, filename: 'assistant.loci-vision' })).structured_content;
  await verifyHandoff(path.join(exports, 'assistant.loci-vision'), source, handoff.artifacts);
  const humanDestination = path.join(output, 'human.loci-vision');
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async (options) => { if (options.title !== 'Export image for a vision assistant') throw new Error('Unexpected vision picker'); return { canceled: false, filePath: destination }; }; }, humanDestination);
  await selectWorkbenchTool(page, 'Agent');
  await vision.getByRole('button', { name: 'Export vision handoff', exact: true }).click();
  await vision.getByText(/^Saved human\.loci-vision/).waitFor();
  await verifyHandoff(humanDestination, source);
  assert.equal(receipt.exports.at(-1).context.rendering.channels[0].color, '#00aaff');
  assert.deepEqual(receipt.exports.at(-1).context.rendering.selection, fixture.selection);
  assert.equal(await hash(fixture.source), fixture.sha256); receipt.checks.push('native-and-mcp-four-artifact-provisional-handoffs');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 768 }));
  for (const theme of ['graphite', 'paper']) {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click(); await page.getByLabel('Application theme', { exact: true }).selectOption(theme); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    for (const surface of ['vision', 'connection']) {
      await selectWorkbenchTool(page, 'Agent');
      if (surface === 'connection') await configureScope();
      const target = surface === 'vision' ? vision : panel;
      await target.scrollIntoViewIfNeeded();
      const layout = await page.evaluate((selector) => { const e = document.querySelector(selector), b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, viewport: window.innerWidth, overflow: e.scrollWidth > e.clientWidth + 2, document_overflow: document.documentElement.scrollWidth > window.innerWidth + 2 }; }, surface === 'vision' ? '.source-agent-controls' : '.research-agent');
      assert.equal(layout.overflow, false); assert.equal(layout.document_overflow, false); assert.ok(layout.x >= -2 && layout.x + layout.width <= layout.viewport + 2);
      const file = `compact-${surface}-${theme}.png`; await page.screenshot({ path: path.join(output, file) }); receipt.screenshots.push(file); receipt.checks.push({ name: `compact-${surface}-${theme}`, layout });
    }
  }
  await fs.rename(policyPath, path.join(access, 'agent-policy.revoked.json'));
  const revoked = await client.call('source_image', { request: imageRequest }, true);
  assert.equal(revoked.content.some((block) => block.type === 'image'), false);
  assert.equal(revoked.structured_content, null); receipt.checks.push('live-policy-revocation');
  await client.close(); client = null;

  // A separate, explicit full-study grant exercises the delegated actor path.
  // Decisions here describe a numerical synthetic-fixture check, never biology.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 }));
  await selectWorkbenchTool(page, 'Agent');
  await panel.getByLabel('Assistant access level', { exact: true }).selectOption('full');
  const fullAccess = path.join(output, 'access-full');
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async options => {
      if (options.title !== 'Choose the permitted agent export folder') throw new Error('Unexpected full-study open picker');
      return { canceled: false, filePaths: [paths.exports] };
    };
    dialog.showSaveDialog = async options => {
      if (options.title !== 'Create private MCP access bundle') throw new Error('Unexpected full-study save picker');
      return { canceled: false, filePath: paths.access };
    };
  }, { exports, access: fullAccess });
  await grant.click();
  await panel.getByLabel('Created agent access receipt', { exact: true }).waitFor();
  const fullPolicyPath = path.join(fullAccess, 'agent-policy.json');
  const fullPolicy = await json(fullPolicyPath);
  assert.equal(fullPolicy.schema, 'loci.agent-policy/v4');
  assert.equal(fullPolicy.delegation.result_scope, 'granted-sources');
  assert.ok(fullPolicy.operations.includes('review_result'));
  assert.equal(fullPolicy.export.filename_mode, 'directory');
  assert.deepEqual(fullPolicy.sources[0].c, [0, 1]);
  assert.deepEqual(fullPolicy.sources[0].crop, { x: 0, y: 0, width: 64, height: 64 });
  await page.screenshot({ path: path.join(output, '02-full-study-access.png') }); receipt.screenshots.push('02-full-study-access.png');
  client = sdkClient(fullPolicyPath); assert.equal((await client.ready).ready, true);
  const fullTools = (await client.tools()).tools;
  for (const name of ['action_guide', 'study_results', 'inspect_action', 'submit_action', 'review_result', 'review_history']) assert.ok(fullTools.includes(name));
  const guide = (await client.call('action_guide', { operation: 'correct_result' })).structured_content;
  assert.equal(guide.actions[0].operation, 'correct_result');
  const listed = (await client.call('study_results', {})).structured_content;
  assert.ok(listed.results.some(item => item.id === result.result.id));
  const parent = (await cli('execute', '--project', study, 'result', '--request', JSON.stringify({ result_id: result.result.id }))).result;
  const beforeLabels = await hash(path.join(study, 'artifacts', `${parent.arrays.labels.sha256}.npy`));
  const correctionInfo = (await client.call('inspect_action', { operation: 'correction_info', request: { result_id: parent.id, revision_hash: parent.revision_hash } })).structured_content;
  assert.deepEqual(correctionInfo.label_ids, [1, 2, 3]);
  const correctionRequest = { result_id: parent.id, revision_hash: parent.revision_hash,
    operations: [{ op: 'delete', label: 1, expected_input_sha256: correctionInfo.label_sha256 }], working_bytes: 64 * 1024 ** 2 };
  assert.equal((await client.call('validate_action', { operation: 'correct_result', request: correctionRequest })).structured_content.authorized, true);
  const correctionJob = (await client.call('submit_action', { operation: 'correct_result', request: correctionRequest, request_key: 'agent-full-correction' })).structured_content.job;
  const correctionDeadline = Date.now() + 30000;
  let correctedJob;
  do {
    correctedJob = (await client.call('job_status', { job_id: correctionJob.id })).structured_content.job;
    if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(correctedJob.state) || correctedJob.owned_worker_active) await page.waitForTimeout(100);
    assert.ok(Date.now() < correctionDeadline, 'Bounded synthetic correction deadline');
  } while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(correctedJob.state) || correctedJob.owned_worker_active);
  assert.equal(correctedJob.state, 'succeeded'); assert.equal(correctedJob.owned_worker_active, false); assert.equal(correctedJob.result_ids.length, 1);
  const child = (await client.call('result', { result_id: correctedJob.result_ids[0] })).structured_content;
  assert.equal(child.result.parent_id, parent.id); assert.equal(child.total_rows, 2); assert.equal(child.result.review, null);
  assert.equal(await hash(path.join(study, 'artifacts', `${parent.arrays.labels.sha256}.npy`)), beforeLabels);
  assert.equal((await client.call('submit_action', { operation: 'correct_result', request: correctionRequest, request_key: 'agent-full-correction' })).structured_content.job.id, correctionJob.id);
  nativeImage(await client.call('result_view', { result_id: child.result.id, labels: false }));
  nativeImage(await client.call('result_view', { result_id: child.result.id, labels: true }));
  receipt.correction_oracle = JSON.parse((await exec(python, [helper, 'verify-correction', study, parent.id, child.result.id], { timeout: 30000 })).stdout);
  const history = (await client.call('review_history', { result_id: child.result.id })).structured_content;
  assert.equal(history.total_events, 0); assert.equal(history.current_review_sha256, null);
  const decision = { result_id: child.result.id, revision_hash: child.result.revision_hash, disposition: 'reviewed',
    reason: 'Automated synthetic-fixture check: deleting label 1 changes exactly 64 pixels and leaves two regions with areas 12 and 24 square micrometres. No biological assessment.',
    coverage: 'Entire 40 by 40 selected synthetic grid; raw image and label arrays checked independently against the known fixture.', expected_review_sha256: null };
  await client.call('review_result', { request: { ...decision, actor: 'human' } }, true);
  const reviewed = (await client.call('review_result', { request: decision })).structured_content.review;
  assert.equal(reviewed.actor, 'agent'); assert.equal(reviewed.authority.policy_sha256, await hash(fullPolicyPath));
  await client.call('export_result', { result_id: child.result.id, revision_hash: child.result.revision_hash, filename: 'agent-corrected-reviewed' });
  const fullExport = path.join(exports, 'agent-corrected-reviewed');
  const exportedHistory = await json(path.join(fullExport, 'review-history.json'));
  assert.deepEqual(exportedHistory.events, [reviewed]);
  assert.equal((await json(path.join(fullExport, 'result.json'))).result.parent_id, parent.id);
  await client.call('export_result', { result_id: child.result.id, revision_hash: child.result.revision_hash, filename: 'agent-corrected-reviewed' }, true);
  receipt.checks.push('full-study-native-preset-v4', 'real-mcp-correction-known-grid-oracle-parent-immutability-idempotency', 'explicit-agent-review-no-human-impersonation-and-directory-export');

  // Cold reopen exposes the actor and allows a researcher decision to supersede
  // the agent event through the real UI. This is a test of that UI route.
  await app.close(); app = null;
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(output, 'reopen-user-data')}`], timeout: 120000 });
  const reopened = await app.firstWindow(); reopened.on('pageerror', error => rendererErrors.push(error.message));
  await app.evaluate(({ dialog, BrowserWindow }, studyPath) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 960 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [studyPath] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  if (receipt.background_window) await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); }
    app.hide();
  });
  await reopened.getByRole('button', { name: 'Open study', exact: true }).click();
  await reopened.locator(`.research-sources [data-result-id="${child.result.id}"]`).click();
  await selectWorkbenchTool(reopened, 'Info');
  await reopened.getByRole('status').filter({ hasText: 'Reviewed by agent' }).waitFor();
  await selectResultSection(reopened, "Review");
  const humanReview = reopened.getByRole('button', { name: 'Mark reviewed', exact: true });
  await reopened.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Mark reviewed' && !button.disabled));
  assert.equal(await humanReview.isEnabled(), true);
  await reopened.getByText('Review history', { exact: true }).click();
  await reopened.getByText(decision.reason, { exact: true }).waitFor();
  await reopened.screenshot({ path: path.join(output, '03-agent-reviewed-correction.png') }); receipt.screenshots.push('03-agent-reviewed-correction.png');
  await humanReview.click();
  await reopened.getByRole('status').filter({ hasText: 'Reviewed by researcher' }).waitFor();
  const superseded = (await client.call('review_history', { result_id: child.result.id })).structured_content;
  assert.equal(superseded.total_events, 2); assert.deepEqual(superseded.events[0], reviewed); assert.equal(superseded.events[1].actor, 'human');
  await client.call('review_result', { request: decision }, true);
  assert.deepEqual((await client.call('review_history', { result_id: child.result.id })).structured_content.events, superseded.events);
  await reopened.screenshot({ path: path.join(output, '04-researcher-supersession.png') }); receipt.screenshots.push('04-researcher-supersession.png');
  const portable = path.join(output, 'delegated-history.loci-study.zip');
  await app.evaluate(({ dialog }, archive) => {
    dialog.showSaveDialog = async options => {
      if (options.title !== 'Export portable study with derived results') throw new Error('Unexpected archive picker');
      return { canceled: false, filePath: archive };
    };
  }, portable);
  await selectWorkbenchTool(reopened, 'Portability');
  await reopened.getByRole('button', { name: 'Export portable study', exact: true }).click();
  const archiveDeadline = Date.now() + 10000;
  while (!(await fs.stat(portable).catch(() => null))?.size) {
    assert.ok(Date.now() < archiveDeadline, 'Portable history export deadline'); await reopened.waitForTimeout(50);
  }
  const portableHistory = JSON.parse((await exec(python, ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(z.read("review-history/"+sys.argv[2]+".json").decode())', portable, child.result.id], { timeout: 30000 })).stdout);
  assert.deepEqual(portableHistory, superseded.events);
  receipt.review_history = superseded; receipt.portable_sha256 = await hash(portable);
  receipt.checks.push('cold-reopen-actor-display-human-ui-supersession-history-stale-write-rejection-portable-export');
  await fs.rename(fullPolicyPath, path.join(fullAccess, 'agent-policy.revoked.json'));
  await client.call('review_result', { request: { ...decision, expected_review_sha256: superseded.current_review_sha256 } }, true);
  await client.close(); client = null;
  assert.deepEqual(rendererErrors, []); assert.deepEqual(await identity(), receipt.build); assert.equal(await hash(fixture.source), fixture.sha256);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = error.stack; receipt.renderer_errors = rendererErrors;
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  let cleanupError = null;
  if (client) await client.close().catch((error) => { cleanupError = error; receipt.cleanup_error = error.stack; receipt.status = 'failed'; });
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => {});
    await app.close().catch((error) => { cleanupError = error; receipt.app_cleanup_error = error.stack; receipt.status = 'failed'; });
  }
  receipt.finished_at = new Date().toISOString(); await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(output);
  if (cleanupError && !receipt.failure) throw cleanupError;
}
