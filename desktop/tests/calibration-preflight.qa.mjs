/** Packaged Q5 boundary journey. Fixtures: tests/fixtures/calibration-preflight.py. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

const repo = path.resolve(import.meta.dirname, '../..');
const required = (name) => {
  assert.ok(process.env[name] && path.isAbsolute(process.env[name]), `${name} requires an absolute path`);
  return process.env[name];
};
const appPath = required('LOCI_PACKAGED_APP');
const fixturePath = required('LOCI_CALIBRATION_FIXTURE');
assert.equal(process.platform, 'darwin', 'This journey targets the packaged macOS worker');
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repo, '.loci/evidence/qa/calibration-preflight'));
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, 'run-'));
const study = path.join(output, 'calibration.loci-study');
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const verifier = path.join(import.meta.dirname, 'fixtures/calibration-preflight.py');
assert.equal(fixture.schema, 'loci.qa.calibration-preflight/v1');
assert.equal(fixture.synthetic, true);
assert.equal(fixture.cases.length, 4);
await fs.cp(fixture.study, study, { recursive: true, errorOnExist: true, force: false });
const hash = async (file) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const executablePath = path.join(appPath, 'Contents/MacOS/Loci');
const identity = async () => ({ executable: await hash(executablePath),
  asar: await hash(path.join(appPath, 'Contents/Resources/app.asar')),
  worker: await hash(path.join(appPath, 'Contents/Resources/loci-engine/loci-engine')) });
const receiptPath = path.join(output, 'receipt.json');
const receipt = { started_at: new Date().toISOString(), app: appPath, build: await identity(), study,
  fixture_manifest: fixturePath, fixture_manifest_sha256: await hash(fixturePath),
  harness_sha256: await hash(import.meta.filename), status: 'running', cases: [], rejections: [] };
const definition = (op, sigma = 300) => {
  const nodes = [
    { id: 'source', type: 'source', settings: {} },
    { id: 'process', type: 'process', settings: { op, sigma } },
    { id: 'segment', type: 'segment', settings: { threshold: 10000 } },
    { id: 'measure', type: 'measure', settings: { measurement_channels: [0] } },
    { id: 'review', type: 'review', settings: {} },
    { id: 'export', type: 'export', settings: {} },
  ];
  return { schema: 'loci.workflow/v1', name: `Synthetic physical ${op}`, nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })) };
};
let app;
try {
  for (const item of fixture.cases) assert.equal(await hash(item.path), item.source_sha256);
  assert.equal(await hash(verifier), fixture.generator_sha256);
  app = await electron.launch({ executablePath,
    args: [`--user-data-dir=${path.join(output, 'user-data')}`], timeout: 120000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ dialog }, studyPath) => {
    dialog.showOpenDialog = async (...args) => {
      if (args.at(-1)?.title !== 'Open research study') throw new Error('Unexpected Q5 picker');
      return { canceled: false, filePaths: [studyPath] };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, study);
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  await page.getByRole('main', { name: 'Research workspace' }).waitFor();
  const execute = (operation, request) => page.evaluate(
    ({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
  const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
  const initial = await snapshot();
  assert.equal(initial.results.length, 0);
  assert.equal(initial.jobs.length, 0);
  assert.deepEqual(initial.sources.map((item) => item.id).sort(), fixture.cases.map((item) => item.source_id).sort());
  for (const [index, op] of ['gaussian', 'subtract_background'].entries()) {
    const workflowId = String(index + 1).repeat(32);
    // The definition saves without a source binding, even above unit-pixel limits.
    const large = await execute('workflow_save', { workflow_id: workflowId, expected_revision: 0,
      definition: definition(op, 1e6) });
    assert.equal(large.workflow.data.definition.nodes[1].settings.sigma, 1e6);
    assert.deepEqual((await execute('workflow_get', { workflow_id: workflowId })).workflow, large.workflow);
    const saved = (await execute('workflow_save', { workflow_id: workflowId, expected_revision: 1,
      definition: definition(op) })).workflow;
    for (const item of fixture.cases) {
      const binding = { workflow_id: saved.id, workflow_revision: saved.revision,
        definition_sha256: saved.data.definition_sha256, source_id: item.source_id,
        source_sha256: item.source_sha256, selection: item.selection };
      const request = { source_id: item.source_id, selection: item.selection,
        recipe: { steps: [{ op, sigma: 300 }], segmentation: { threshold: 10000 }, measurement_channels: [0] } };
      if (!item.coarse) {
        const before = await snapshot();
        for (const operation of ['recipe_preflight', 'validate_recipe', 'preview_recipe', 'run_recipe',
          'workflow_preflight', 'workflow_preview', 'workflow_run']) {
          const payload = operation.startsWith('workflow_')
            ? { ...binding, ...(operation === 'workflow_preview' ? { target_node_id: 'measure' } : {}) } : request;
          await assert.rejects(() => execute(operation, payload), /Gaussian sigma exceeds 256 voxels/);
          receipt.rejections.push({ fixture: item.name, op, operation });
        }
        const after = await snapshot();
        assert.deepEqual(after.jobs.map((item) => item.id), before.jobs.map((item) => item.id));
        assert.deepEqual(after.results.map((item) => item.id), before.results.map((item) => item.id));
        continue;
      }
      assert.equal(Math.max(...item.sigma_voxels), 150);
      const preflight = await execute('recipe_preflight', request);
      assert.equal(preflight.within_budget, true);
      const prepared = await execute('workflow_preflight', binding);
      assert.deepEqual(prepared.recipe, preflight.recipe);
      assert.equal(prepared.recipe_sha256, preflight.recipe_sha256);
      const count = (await snapshot()).results.length;
      const preview = await execute('preview_recipe', request);
      const workflowPreview = await execute('workflow_preview', { ...binding, target_node_id: 'measure' });
      assert.equal(preview.job.state, 'succeeded');
      assert.equal(workflowPreview.job.state, 'succeeded');
      assert.equal(preview.adopted, false);
      assert.equal(workflowPreview.adopted, false);
      assert.equal((await snapshot()).results.length, count);
      assert.equal(preview.image, workflowPreview.image);
      assert.deepEqual(preview.provenance.processing, workflowPreview.provenance.processing);
      assert.deepEqual(preview.provenance.processing[0].sigma_voxels, item.sigma_voxels);
      assert.equal(preview.provenance.processing[0].unit, 'um');
      const direct = await execute('run_recipe', request);
      const workflow = await execute('workflow_run', binding);
      assert.equal(direct.job.state, 'succeeded');
      assert.equal(workflow.job.state, 'succeeded');
      assert.deepEqual(direct.measurements, workflow.measurements);
      assert.equal((await snapshot()).results.length, count + 2);
      for (const result of [direct.result, workflow.result]) {
        assert.equal(result.source_sha256, item.source_sha256);
        const record = await execute('result', { result_id: result.id });
        assert.equal(record.provenance.recipe_sha256, preflight.recipe_sha256);
        assert.deepEqual(record.provenance.processing, preview.provenance.processing);
        assert.deepEqual(record.provenance.geometry, preview.provenance.geometry);
        const rendered = await execute('result_view', { result_id: result.id, labels: false });
        assert.equal(rendered.image, preview.image);
      }
      receipt.cases.push({ fixture: item.name, op, source_id: item.source_id,
        source_sha256: item.source_sha256, sigma_voxels: item.sigma_voxels,
        recipe_sha256: preflight.recipe_sha256, definition_sha256: saved.data.definition_sha256,
        result_ids: [direct.result.id, workflow.result.id], job_ids: [direct.job.id, workflow.job.id] });
    }
  }
  assert.equal(receipt.cases.length, 4);
  assert.equal(receipt.rejections.length, 28);
  assert.deepEqual(errors, []);
  assert.deepEqual(await identity(), receipt.build);
  for (const item of fixture.cases) assert.equal(await hash(item.path), item.source_sha256);
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  const python = process.env.LOCI_QA_PYTHON ?? path.join(repo, 'engine/.venv/bin/python');
  const numerical = await promisify(execFile)(python, [verifier, '--manifest', fixturePath,
    '--verify-receipt', receiptPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  receipt.numerical_oracle = JSON.parse(numerical.stdout);
  assert.equal(receipt.numerical_oracle.status, 'passed');
  assert.equal(receipt.numerical_oracle.arrays_checked, 8);
  receipt.oracle_verifier_sha256 = await hash(verifier);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = error.stack; throw error;
} finally {
  receipt.finished_at = new Date().toISOString();
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  if (app) await app.close();
  console.log(JSON.stringify({ evidence: output, status: receipt.status }));
}
