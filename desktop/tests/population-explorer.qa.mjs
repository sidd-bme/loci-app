/** Real-image packaged workflow. Inputs come from scripts/qa/population-real-images.py. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { selectWorkbenchTool } from './workbench-qa-helpers.mjs';

const appPath = process.env.LOCI_PACKAGED_APP;
const studyPath = process.env.LOCI_POPULATION_STUDY;
const reportPath = process.env.LOCI_POPULATION_REPORT;
assert.ok(appPath && studyPath && reportPath, 'Set explicit packaged app, real-image study and numerical report.');
const root = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? '../.loci/evidence/2026-10-03/object-population/packaged-real');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'run-'));
const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
assert.equal(report.measurement_correctness, 'passed');
assert.equal(report.source_stable_during_run, true);
const hash = async (file) => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const executablePath = path.join(appPath, 'Contents/MacOS/Loci');
const identity = async () => ({ executable: await hash(executablePath), asar: await hash(path.join(appPath, 'Contents/Resources/app.asar')),
  worker: await hash(path.join(appPath, 'Contents/Resources/loci-engine/loci-engine')) });
const receipt = { started_at: new Date().toISOString(), app: appPath, build: await identity(), study: studyPath,
  numerical_report: reportPath, numerical_report_sha256: await hash(reportPath), checks: [], status: 'running' };
let app;
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(output, 'user-data')}`], timeout: 120000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog }, study) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1400, height: 960 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [study] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, studyPath);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const expectedResults = report.fields.flatMap((field) => Object.values(field.methods).map((method) => ({ ...method, filename: field.filename })));
  assert.equal(snapshot.results.length, expectedResults.length);
  // Recheck each real-field population through the packaged IPC worker.
  for (const expected of expectedResults) {
    const result = snapshot.results.find((item) => item.id === expected.result_id);
    assert.ok(result && result.revision_hash === expected.revision_hash);
    const answer = await page.evaluate((binding) => window.lociResearch.execute('population_query', { ...binding, limit: 25 }),
      { result_id: result.id, revision_hash: result.revision_hash });
    assert.equal(answer.total_count, result.object_count);
    assert.equal(answer.histogram.counts.reduce((sum, value) => sum + value, 0), answer.total_count);
    assert.equal(answer.source_sha256, result.source_sha256);
    receipt.checks.push({ result_id: result.id, total_count: answer.total_count, membership_sha256: answer.membership_sha256 });
  }
  const result = [...snapshot.results].sort((a, b) => b.object_count - a.object_count)[0];
  assert.ok(result.object_count > 25, 'Real workflow must exercise paging.');
  const source = snapshot.sources.find((item) => item.id === result.source_id);
  await page.locator('.research-sources').getByRole('button', { name: new RegExp(source.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await page.locator(`[data-result-id="${result.id}"]`).click();
  await selectWorkbenchTool(page, 'Population');
  const panel = page.getByRole('region', { name: 'Object population explorer', exact: true });
  await panel.getByText(`${result.object_count} of ${result.object_count} objects match.`, { exact: true }).waitFor();
  await page.waitForFunction((id) => document.querySelector(`[data-viewer-source="${id}"]`)?.getAttribute('data-prepared') === 'true', source.id);
  assert.equal(await page.locator('.result-source-count').textContent(), `${result.object_count} objects`);
  await page.screenshot({ path: path.join(output, '01-real-population.png') });
  const query = async (extra = {}) => page.evaluate((request) => window.lociResearch.execute('population_query', request),
    { result_id: result.id, revision_hash: result.revision_hash, limit: 25, ...extra });
  const first = await query();
  const xMetric = first.metrics.find((metric) => metric.id === 'measure');
  assert.equal(xMetric.unit, 'pixel^2');
  const lastOffset = Math.floor((result.object_count - 1) / 25) * 25;
  assert.ok(lastOffset >= 200, 'Real workflow must select beyond the legacy 200-object page.');
  for (let offset = 25; offset <= lastOffset; offset += 25) {
    await panel.getByRole('button', { name: 'Next page', exact: true }).click();
    const expectedPage = await query({ offset });
    await panel.locator(`tr[data-label="${expectedPage.rows[0].label}"]`).waitFor();
  }
  const second = await query({ offset: lastOffset });
  await panel.locator(`tr[data-label="${second.rows[0].label}"]`).waitFor();
  await panel.getByRole('region', { name: 'Filtered object measurements' }).focus();
  await page.keyboard.press('Home');
  const selected = panel.getByLabel('Selected population object');
  await selected.getByRole('heading', { name: `Object #${second.rows[0].label}`, exact: true }).waitFor();
  const label = second.rows[0].label;
  await panel.getByRole('button', { name: 'Locate selected object', exact: true }).click();
  const located = await page.evaluate((request) => window.lociResearch.execute('population_locate', request),
    { result_id: result.id, revision_hash: result.revision_hash, label });
  const picked = await page.evaluate((request) => window.lociResearch.execute('result_label_at', request),
    { result_id: result.id, revision_hash: result.revision_hash, axis: 'z', index: 0, u: located.point_index[1], v: located.point_index[0] });
  assert.equal(picked.label, label);
  // Select a different table row without moving the image, then pick the owned
  // pixel with a real pointer. The target is beyond the legacy first200 rows.
  const other = second.rows.find((row) => row.label !== label);
  assert.ok(other);
  await panel.locator(`tr[data-label="${other.label}"] button`).click();
  await selected.getByRole('heading', { name: `Object #${other.label}`, exact: true }).waitFor();
  const viewer = page.locator(`[data-viewer-source="${source.id}"]`);
  await page.waitForFunction((id) => document.querySelector(`[data-viewer-source="${id}"]`)?.getAttribute('data-prepared') === 'true', source.id);
  const point = await viewer.evaluate((element, pixel) => {
    const camera = JSON.parse(element.getAttribute('data-camera'));
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2 + (pixel[1] + 0.5 - camera.x) * camera.scale,
      y: bounds.top + bounds.height / 2 + (pixel[0] + 0.5 - camera.y) * camera.scale };
  }, located.point_index);
  await page.mouse.click(point.x, point.y);
  await selected.getByRole('heading', { name: `Object #${label}`, exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, '02-selected-real-object.png') });
  await panel.getByRole('button', { name: 'Add range', exact: true }).click();
  await panel.getByLabel('Population minimum', { exact: true }).fill('100');
  await panel.getByLabel('Population maximum', { exact: true }).fill('1000');
  await panel.getByRole('button', { name: 'Apply filter', exact: true }).click();
  const filtered = await query({ filters: [{ metric: 'measure', min: 100, max: 1000 }] });
  await panel.getByText(new RegExp(`^${filtered.filtered_count} of ${result.object_count} objects match`)).waitFor();
  await page.screenshot({ path: path.join(output, '03-filtered-real-population.png') });
  const exportedPath = path.join(output, 'population-query-receipt.json');
  await app.evaluate(({ session }, destination) => {
    globalThis.populationDownload = new Promise((resolve) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(destination);
        item.once('done', (_event, state) => resolve(state));
      });
    });
  }, exportedPath);
  await panel.getByText('Source & query details', { exact: true }).click();
  await panel.getByRole('button', { name: 'Download query receipt', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.populationDownload), 'completed');
  const exported = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
  assert.equal(exported.schema, 'loci.population-query-receipt/v1');
  assert.equal(exported.result_id, result.id);
  assert.equal(exported.source_sha256, source.sha256);
  const replay = await query(exported.query);
  assert.equal(exported.membership_sha256, replay.membership_sha256);
  assert.equal(exported.query_sha256, replay.query_sha256);
  assert.equal(exported.filtered_count, replay.filtered_count);
  receipt.query_receipt = { path: exportedPath, sha256: await hash(exportedPath), replay: 'exact' };

  await panel.getByLabel('Population minimum', { exact: true }).fill('1000000000');
  await panel.getByLabel('Population maximum', { exact: true }).fill('');
  await panel.getByRole('button', { name: 'Apply filter', exact: true }).click();
  await panel.getByText('No objects match. Clear or widen the numeric ranges.', { exact: true }).waitFor();
  await panel.getByText('This selected object is outside the current ranges.', { exact: true }).waitFor();
  assert.equal(await panel.locator('.population-histogram').count(), 0);
  await panel.getByText('No finite Area values match these ranges.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, '04-empty-filter-selected-retained.png') });
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await panel.getByText(`${result.object_count} of ${result.object_count} objects match.`, { exact: true }).waitFor();
  await panel.getByLabel('Population sort metric', { exact: true }).selectOption('label');
  await panel.getByLabel('Population sort direction', { exact: true }).selectOption('desc');
  const reversed = await query({ sort: { metric: 'label', direction: 'desc' } });
  await panel.locator(`tr[data-label="${reversed.rows[0].label}"]`).waitFor();
  const revision = snapshot.results.find((item) => item.source_id === source.id && item.id !== result.id);
  assert.ok(revision, 'Compare independently segmented results of the same real field.');
  await page.locator(`[data-result-id="${revision.id}"]`).click();
  await panel.getByText(`${revision.object_count} of ${revision.object_count} objects match.`, { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Selected population object').count(), 0);
  assert.equal(await panel.getByLabel('Population sort metric').inputValue(), 'label');
  assert.equal(await panel.getByLabel('Population sort direction').inputValue(), 'asc');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1050, height: 760 }));
  await page.screenshot({ path: path.join(output, '05-compact-new-result.png') });
  for (const theme of ['graphite', 'midnight', 'paper', 'aurora', 'ember', 'lagoon', 'fiji']) {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByLabel('Application theme', { exact: true }).selectOption(theme);
    if (theme === 'paper') await page.getByRole('radio', { name: 'Large', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.screenshot({ path: path.join(output, `theme-${theme}.png`) });
    const overflow = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 2);
    assert.equal(overflow, false, `${theme} population inspector overflows`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await identity(), receipt.build);
  receipt.workflow = { result_id: result.id, chosen_label: label, owned_pixel: located.point_index,
    filtered_count: filtered.filtered_count, switched_result: revision.id, keyboard_selection: true, real_image_pick_beyond_200: true,
    explicit_pixel_units: true, selected_outside_filter_retained: true, source_hashes: snapshot.sources.map((item) => item.sha256) };
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.failure = error.stack; throw error; }
finally {
  receipt.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => {});
    await app.close();
  }
  console.log(JSON.stringify({ evidence: output, status: receipt.status }));
}
