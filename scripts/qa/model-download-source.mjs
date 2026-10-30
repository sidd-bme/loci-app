/** Explicit live-network acceptance of the pinned source downloader.
 * Run manually with Node24 and --output <new private directory>. Downloads only
 * the reviewed cpsam_v2 checkpoint. Never imports or executes checkpoint bytes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { downloadModelArtifact } from '../../desktop/src/main/model-download.ts';
import { CELLPOSE_DOWNLOADS } from '../../desktop/src/main/cellpose-models.ts';

const index = process.argv.indexOf('--output');
const output = process.argv[index + 1];
assert.ok(index > 0 && output && path.isAbsolute(output));
await fs.mkdir(output, { mode: 0o700 });
assert.equal(await fs.realpath(output), output);
const artifact = CELLPOSE_DOWNLOADS.find(value => value.id === 'cpsam_v2');
assert.ok(artifact);
const hash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const receipt = { schema: 'loci.pinned-download-network-qa/v1', started_at: new Date().toISOString(), status: 'running', artifact,
  scope: 'Real pinned model download and interrupted-stream cleanup; no checkpoint execution or scientific validation',
  source_sha256: {
    downloader: await hash(new URL('../../desktop/src/main/model-download.ts', import.meta.url)),
    registry: await hash(new URL('../../desktop/src/main/cellpose-models.ts', import.meta.url)),
  } };
let failure;
try {
  const cancelledRoot = path.join(output, 'cancelled'); await fs.mkdir(cancelledRoot, { mode: 0o700 });
  const controller = new AbortController();
  const pending = downloadModelArtifact(artifact.id, CELLPOSE_DOWNLOADS, path.join(cancelledRoot, 'checkpoint'), { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  let observedBytes = 0, finished = false;
  void pending.then(() => { finished = true; });
  const until = Date.now() + 60000;
  while (!finished && Date.now() < until && observedBytes < 65536) {
    for (const name of await fs.readdir(cancelledRoot)) {
      if (!name.startsWith('.loci-model-download-')) continue;
      try { observedBytes = (await fs.stat(path.join(cancelledRoot, name, 'artifact.part'))).size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (observedBytes < 65536) await new Promise(resolve => setTimeout(resolve, 50));
  }
  controller.abort();
  const cancelled = await pending;
  assert.ok(observedBytes >= 65536, `No downloaded bytes observed before cancellation: ${cancelled.error?.message ?? 'completed too early'}`);
  assert.match(cancelled.error?.message ?? '', /cancelled/u);
  assert.deepEqual(await fs.readdir(cancelledRoot), []);
  receipt.cancel = { status: 'passed', observed_partial_bytes: observedBytes, retained_entries: [] };
  process.stdout.write(JSON.stringify({ phase: 'cancel', ...receipt.cancel }) + '\n');

  const completedRoot = path.join(output, 'verified'); await fs.mkdir(completedRoot, { mode: 0o700 });
  const result = await downloadModelArtifact(artifact.id, CELLPOSE_DOWNLOADS, path.join(completedRoot, artifact.id));
  assert.equal((await fs.stat(result.path)).size, artifact.sizeBytes);
  assert.equal(await hash(result.path), artifact.sha256);
  assert.deepEqual(await fs.readdir(completedRoot), [artifact.id]);
  receipt.download = result; receipt.status = 'passed';
} catch (error) { failure = error; receipt.status = 'failed'; receipt.error = { message: error.message, stack: error.stack }; }
finally {
  receipt.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: receipt.status, output, error: receipt.error?.message }) + '\n');
}
if (failure) throw failure;
