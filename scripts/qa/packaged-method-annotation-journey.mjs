/** Fresh packaged macOS method/annotation engineering journey.
 *
 * Run with Node 24, LOCI_PACKAGED_APP=/absolute/Loci.app,
 * LOCI_QA_PYTHON=/absolute/python-with-numpy-and-tifffile,
 * LOCI_QA_OUTPUT_ROOT=/absolute/existing/evidence-directory,
 * LOCI_QA_SOURCE_COMMIT=<40-character packaged source revision>.
 *
 * Native picker responses and the fixture rights confirmation are explicitly
 * harness simulations; every privileged operation still traverses the real
 * preload/main/packaged worker. No method execution or human review is claimed.
 * This script never installs dependencies, edits source, builds or downloads.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { createEmptyStudy, fileMenuAction, selectWorkbenchTool, selectResultSection } from '../../desktop/tests/workbench-qa-helpers.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(repo, 'desktop/package.json'));
const { _electron: electron } = require('playwright');
const exec = promisify(execFile), env = process.env;
assert.equal(process.platform, 'darwin', 'This journey qualifies the packaged macOS refusal/adoption route');
assert.equal(process.versions.node.split('.')[0], '24', 'Use supported Node 24');
for (const name of ['LOCI_PACKAGED_APP', 'LOCI_QA_PYTHON', 'LOCI_QA_OUTPUT_ROOT'])
  assert.ok(path.isAbsolute(env[name] ?? ''), `${name} must be an explicit absolute path`);
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/u);
const bundle = env.LOCI_PACKAGED_APP, python = env.LOCI_QA_PYTHON;
const executable = path.join(bundle, 'Contents/MacOS/Loci');
const worker = path.join(bundle, 'Contents/Resources/loci-engine/loci-engine');
const output = await fs.mkdtemp(path.join(env.LOCI_QA_OUTPUT_ROOT, 'packaged-method-annotation-'));
const study = path.join(output, 'authored.loci-study'), restored = path.join(output, 'restored.loci-study');
const source = path.join(output, 'authored.ome.tif'), offline = source + '.offline';
const alternate = path.join(output, 'alternate.ome.tif');
const packagePath = path.join(output, 'authored-method.json'), outputPath = path.join(output, 'external-output.bin');
const inputArchive = path.join(output, 'exact-inputs.zip'), portable = path.join(output, 'portable.loci-study.zip');
const sha = async file => { const h = createHash('sha256'); assert.equal((await fs.lstat(file)).isFile(), true); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const binding = result => ({ result_id: result.id, revision_hash: result.revision_hash });
const selection = { x: 0, y: 0, width: 32, height: 32, z: 1, t: 0, c: 0, level: 0 };
const receipt = { schema: 'loci.packaged-method-annotation-qa/v1', status: 'running', output,
  source_commit: env.LOCI_QA_SOURCE_COMMIT, started_at: new Date().toISOString(),
  scientific_qualification: 'not-established', human_review: false,
  limits: ['Picker responses and native method-rights confirmation are simulated and recorded.',
    'Adopted output is authored technical data; its production does not qualify imported code.',
    'macOS controlled local execution remains unavailable; no Linux runtime qualification is claimed.',
    'Cold retained reads run with both authored source files absent and a fresh profile; decoder entry points are not instrumented.',
    'The agent session is a real local Python MCP SDK client, not a Codex-host acceptance claim.'],
  checks: [], failures_expected: [], screenshots: [], dialogs: [], renderer_errors: [], network_requests: [], processes: [] };
let app, page, failure, processTimer, processScan = Promise.resolve(), picker = {}, mcpPending;
const owned = new Map();
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const execute = (operation, request = {}) => page.evaluate(({ operation, request }) => window.lociResearch.execute(operation, request), { operation, request });
const api = (name, args = []) => page.evaluate(({ name, args }) => window.lociResearch[name](...args), { name, args });
async function wait(read, accept, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds; let last;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await page.waitForTimeout(50); }
  throw new Error(`${label}: timed out; ${JSON.stringify(last)}`);
}
async function shot(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); receipt.screenshots.push({ name, sha256: await sha(file) }); }
async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 3000 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => { const f = line.trim().split(/\s+/u); return [Number(f[0]), { parent: Number(f[1]), start: f.slice(2).join(' ') }]; }));
}
async function remember() {
  if (!app) return;
  const rows = await processes(), roots = new Set([app.process().pid]);
  for (const [pid, start] of owned) if (rows.get(pid)?.start === start) roots.add(pid);
  for (;;) { const count = roots.size; for (const [pid, row] of rows) if (roots.has(row.parent)) roots.add(pid); if (count === roots.size) break; }
  for (const pid of roots) if (rows.has(pid)) owned.set(pid, rows.get(pid).start);
}
async function installPickers() {
  await app.evaluate(({ dialog }, value) => {
    globalThis.__methodAnnotationPicker = value;
    globalThis.__methodAnnotationDialogs ??= [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title, p = globalThis.__methodAnnotationPicker;
      const selected = { 'Open research study': p.openStudy, 'Add microscopy or medical images': p.source,
        'Import a controlled method': p.package, 'Choose external method output': p.methodOutput,
        'Import portable Loci study': p.archive }[title];
      if (!selected) throw new Error('Unexpected simulated open picker: ' + title);
      globalThis.__methodAnnotationDialogs.push({ title, simulation: true, selected_basename: selected.split('/').at(-1) });
      return { canceled: false, filePaths: [selected] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title, p = globalThis.__methodAnnotationPicker;
      const selected = { 'Create research study': p.study, 'Export exact method inputs': p.inputs,
        'Export reviewed result bundle': p.exported, 'Export portable study with derived results': p.archive,
        'Choose a new study directory': p.restored,
        'Create private MCP access bundle': p.agentBundle }[title];
      if (!selected) throw new Error('Unexpected simulated save picker: ' + title);
      globalThis.__methodAnnotationDialogs.push({ title, simulation: true, selected_basename: selected.split('/').at(-1) });
      return { canceled: false, filePath: selected };
    };
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.message !== 'Approve rights for this exact method?') throw new Error('Unexpected simulated confirmation: ' + options.message);
      globalThis.__methodAnnotationDialogs.push({ message: options.message, simulation: true, response: 1,
        basis: 'Authored Apache-2.0 technical fixture rights decision; no human or scientific approval' });
      return { response: 1, checkboxChecked: false };
    };
  }, picker);
}
async function launch(number) {
  const profile = path.join(output, 'profile-' + number);
  app = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile],
    cwd: path.join(repo, 'desktop'), timeout: 120000, env: { ...env, LOCI_MODEL_HOME: path.join(profile, 'models') } });
  await remember(); processTimer = setInterval(() => { processScan = processScan.then(remember).catch(error => { receipt.process_tracking_error = error.message; }); }, 250);
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => receipt.renderer_errors.push(error.message));
  page.on('request', request => { if (/^https?:/u.test(request.url())) receipt.network_requests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ width: 1440, height: 1000 }); w.show(); });
  await page.waitForFunction(() => Boolean(window.lociResearch)); await installPickers();
}
async function close() {
  clearInterval(processTimer); await processScan;
  if (!app) return;
  await remember(); receipt.dialogs.push(...await app.evaluate(() => globalThis.__methodAnnotationDialogs ?? []));
  const current = app, closed = current.waitForEvent('close', { timeout: 30000 });
  let quitError;
  try { await current.evaluate(({ app }) => app.quit()); await closed; }
  catch (error) { quitError = error; await current.close().catch(() => {}); }
  finally { app = undefined; page = undefined; }
  let rows = await processes();
  for (let i = 0; i < 20 && [...owned].some(([pid, start]) => rows.get(pid)?.start === start); i++) {
    await new Promise(resolve => setTimeout(resolve, 100)); rows = await processes();
  }
  let remaining = [...owned].filter(([pid, start]) => rows.get(pid)?.start === start);
  const record = { observed: [...owned].map(([pid, start]) => ({ pid, start })), survivors_after_quit: remaining.map(([pid]) => pid) };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const [pid, start] of remaining) if ((await processes()).get(pid)?.start === start)
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (remaining.length) await new Promise(resolve => setTimeout(resolve, 500));
    rows = await processes(); remaining = [...owned].filter(([pid, start]) => rows.get(pid)?.start === start);
  }
  record.final_survivors = remaining.map(([pid]) => pid); receipt.processes.push(record); owned.clear();
  assert.deepEqual(record.final_survivors, []); assert.deepEqual(record.survivors_after_quit, [], 'Ordinary quit required forced cleanup');
  if (quitError) throw quitError;
}
async function denied(operation, request, pattern) {
  const before = await snapshot(); let message;
  try { await execute(operation, request); } catch (error) { message = error.message; }
  assert.ok(message, `${operation} unexpectedly succeeded`); assert.match(message, pattern);
  const after = await snapshot(); assert.deepEqual(after.results.map(binding), before.results.map(binding));
  receipt.failures_expected.push({ operation, message }); return after;
}
async function task(operation, request) {
  const output = await execute(operation, request);
  assert.equal(output.job?.state, 'succeeded', JSON.stringify(output));
  assert.equal(output.job.operation, operation); assert.equal(output.job.owner ?? null, null);
  assert.deepEqual(output.job.result_ids, [output.result.id]);
  receipt.checks.push({ operation, job_id: output.job.id, result: binding(output.result) });
  return output.result;
}
async function chooseResult(result) {
  await page.locator(`button[data-source-id="${result.source_id}"]`).click();
  await page.locator(`button[data-result-id="${result.id}"]`).click();
  await page.locator(`button[data-result-id="${result.id}"][aria-pressed="true"]`).waitFor();
}
async function refreshStudy() { await fileMenuAction(page, 'Open study'); await page.locator('main.image-first-workbench').waitFor(); }
async function buildIdentity() {
  return { executable: await sha(executable), asar: await sha(path.join(bundle, 'Contents/Resources/app.asar')),
    worker: await sha(worker), manifest: await json(path.join(bundle, 'Contents/Resources/loci-build-identity.json')) };
}

// Independent setup/array oracle imports no Loci code or test helpers.
const oracleCode = String.raw`
import hashlib,json,struct,sys,zipfile
from pathlib import Path
import numpy as np
import tifffile
mode=sys.argv[1]; c=json.loads(Path(sys.argv[2]).read_text()); root=Path(c['output'])
def sha(data): return hashlib.sha256(data).hexdigest()
labels=np.zeros((32,32),np.uint32); labels[4:12,4:12]=1
raw=np.zeros((1,2,2,32,32),np.uint16); raw[0,0,1,4:12,4:12]=100; raw[0,1]=20
if mode=='setup':
    tifffile.imwrite(root/'authored.ome.tif',raw,ome=True,metadata={'axes':'TCZYX'})
    altered=raw.copy(); altered[0,0,1,4:12,4:12]=101
    tifffile.imwrite(root/'alternate.ome.tif',altered,ome=True,metadata={'axes':'TCZYX'})
    print(json.dumps({'source_sha256':sha((root/'authored.ome.tif').read_bytes()),'label_pixels':64}))
elif mode=='input':
    with zipfile.ZipFile(root/'exact-inputs.zip') as z:
        assert set(z.namelist())=={'input.bin','binding.json','manifest.json','module.wasm','receipt.json'}
        buf=z.read('input.bin'); magic,nm,nl,nr,reserved=struct.unpack_from('<8sIIII',buf)
        assert magic==b'LOCIMI01' and reserved==0 and len(buf)==24+nm+nl+nr
        meta=json.loads(buf[24:24+nm]); assert meta['source_sha256']==c['source_sha256']
        assert meta['label_revision_sha256']==c['parent']['revision_hash']
        lo=24+nm; np.testing.assert_array_equal(np.frombuffer(buf[lo:lo+nl],'<u4').reshape(32,32),labels)
        ro=lo+nl; channels=np.frombuffer(buf[ro:],'<u2').reshape(2,32,32)
        np.testing.assert_array_equal(channels,np.stack([raw[0,1,1],raw[0,0,1]]))
        assert sha(buf)==c['input_sha256']; assert meta['label_sha256']==sha(buf[lo:lo+nl])
        assert meta['raw_sha256']==sha(buf[ro:]); assert json.loads(z.read('binding.json'))==c['preflight']
        assert sha(z.read('module.wasm'))==c['module_sha256']
    print(json.dumps({'exact_abi':True,'raw_channel_order':[1,0],'pixels':64,'input_sha256':sha(buf)}))
elif mode=='exports':
    for name,result in c['results'].items():
        directory=root/('export-'+name); saved=json.loads((directory/'result.json').read_text())
        assert saved['result']['id']==result['id'] and saved['result']['revision_hash']==result['revision_hash']
        assert saved['review']['disposition']=='reviewed'
        arrays={}
        for key,d in result['arrays'].items():
            file=directory/(key+'.npy'); assert sha(file.read_bytes())==d['sha256']
            a=np.load(file,allow_pickle=False); assert list(a.shape)==d['shape'] and str(a.dtype)==d['dtype']; arrays[key]=a
        np.testing.assert_array_equal(arrays['labels'],labels)
        if name=='method':
            np.testing.assert_array_equal(arrays['method_raw'],np.stack([raw[0,1,1],raw[0,0,1]]))
            assert arrays['method_output'].astype(np.uint8).tobytes()==(root/'external-output.bin').read_bytes()
        else:
            np.testing.assert_array_equal(arrays['reference_labels'],labels)
            report=json.loads((directory/'annotation-evaluation.json').read_text()); metrics=report['metrics']
            assert metrics['region']['intersection_pixels']==64 and metrics['region']['union_pixels']==64
            assert metrics['region']['iou']==metrics['region']['dice']==1
            instances=metrics['instances']; assert instances['reference_count']==instances['prediction_count']==1
            assert instances['count_error_absolute']==0
            for s in instances['scores']:
                assert (s['true_positive'],s['false_positive'],s['false_negative'])==(1,0,0)
                assert s['precision']==s['recall']==s['f1']==1
                assert s['matches']==[{'reference_label':1,'prediction_label':1,'intersection_pixels':64,'union_pixels':64,'iou':1.0}]
    with zipfile.ZipFile(root/'portable.loci-study.zip') as z:
        assert not any(n.endswith(('.tif','.tiff')) for n in z.namelist())
        assert not any('/controlled_method_authority/' in n or '/controlled_method_output_grant/' in n for n in z.namelist())
    print(json.dumps({'exact_export_arrays':True,'independent_agreement':{'intersection':64,'union':64,'f1':1},'portable_live_authority_absent':True}))
else: raise AssertionError('Unknown oracle mode')
`;
async function oracle(mode, values = {}) {
  const config = path.join(output, 'oracle-' + mode + '.json'); await writeJson(config, { output, ...values });
  const result = await exec(python, ['-c', oracleCode, mode, config], { cwd: output, timeout: 30000, maxBuffer: 4 * 1024**2 });
  const checked = JSON.parse(result.stdout); await writeJson(path.join(output, 'oracle-' + mode + '-receipt.json'), checked); return checked;
}
function wasmModule() {
  const uleb = n => { const b = []; do { let byte = n & 127; n >>>= 7; if (n) byte |= 128; b.push(byte); } while (n); return Buffer.from(b); };
  const section = (id, bytes) => Buffer.concat([Buffer.from([id]), uleb(bytes.length), bytes]);
  const name = Buffer.from('loci_method_v1');
  return Buffer.concat([Buffer.from('0061736d01000000', 'hex'),
    section(1, Buffer.from('0160047f7f7f7f017f', 'hex')), section(3, Buffer.from([1, 0])),
    section(5, Buffer.from('0101018004', 'hex')),
    section(7, Buffer.concat([Buffer.from('02066d656d6f72790200', 'hex'), Buffer.from([name.length]), name, Buffer.from([0, 0])])),
    section(10, Buffer.from([1, 4, 0, 0x41, 0, 0x0b]))]);
}

// Real local MCP SDK/stdio session against the native-generated frozen command.
// A ready file synchronizes the screenshot with actual durable session events;
// no renderer DOM, agent journal or session record is synthesized.
const mcpCode = String.raw`
import asyncio,json,sys,time
from pathlib import Path
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters,stdio_client
c=json.loads(Path(sys.argv[1]).read_text()); root=Path(c['output']); transcript=[]
async def main():
    config=json.loads(Path(c['config']).read_text())['mcpServers']['loci-research']
    assert Path(config['command']).resolve()==Path(c['worker']).resolve(),config
    with (root/'mcp-stderr.log').open('w') as log:
        parameters=StdioServerParameters(command=config['command'],args=config['args'],env=config.get('env'),cwd=config.get('cwd'))
        async with stdio_client(parameters,errlog=log) as (read,write),ClientSession(read,write) as client:
            initialized=await client.initialize(); transcript.append({'initialize':initialized.model_dump(mode='json')})
            async def call(name,args,deny=False):
                result=await client.call_tool(name,args)
                transcript.append({'tool':name,'arguments':args,'response':result.model_dump(mode='json')})
                assert bool(result.is_error)==deny,transcript[-1]
                if deny:return None
                if result.structured_content is not None:return result.structured_content
                return json.loads(next(block.text for block in result.content if block.type=='text'))
            guide=await call('action_guide',{})
            names={a['operation'] for a in guide['actions']}
            assert {'method_query','annotation_evaluation_run','annotation_evaluation_get'}<=names
            assert not {'method_import','method_output_grant'} & names
            values=await call('inspect_action',{'operation':'method_query','request':{**c['method'],'offset':0,'limit':1}})
            assert values['rows']==[{'label_id':1,'values':[64.0,0.375]}]
            await call('validate_action',{'operation':'annotation_evaluation_run','request':c['outside']},deny=True)
            submitted=await call('submit_action',{'operation':'annotation_evaluation_run','request':c['comparison'],'request_key':'packaged-annotation-agreement'})
            jobid=submitted['job']['id']; deadline=time.monotonic()+30
            while True:
                job=(await call('job_status',{'job_id':jobid}))['job']
                if job['state'] not in {'queued','running'}:break
                assert time.monotonic()<deadline,job
                await asyncio.sleep(0.025)
            assert job['state']=='succeeded',job
            # Actual supervisor disposal can finish just after durable publication.
            # Readiness is bounded and every transient response is retained.
            end=time.monotonic()+10
            while True:
                # result() supplies the exact newly published immutable revision.
                result=await client.call_tool('result',{'result_id':job['result_ids'][0]})
                transcript.append({'tool':'result','response':result.model_dump(mode='json')})
                if not result.is_error:break
                assert 'Another analysis' in str(result.content) and time.monotonic()<end,result
                await asyncio.sleep(0.025)
            value=result.structured_content
            if value is None:value=json.loads(next(block.text for block in result.content if block.type=='text'))
            returned=value['result']; exact={'result_id':returned['id'],'revision_hash':returned['revision_hash']}
            report=await call('inspect_action',{'operation':'annotation_evaluation_get','request':{**exact,'table':'summary'}})
            assert report['annotation_evaluation']['metrics']['region']['iou']==1
            (root/'mcp-ready.json').write_text(json.dumps({'job_id':jobid,'result':exact,'declared_client':'packaged-method-annotation-qa','actual_transport':'stdio','worker':config['command']}))
            deadline=time.monotonic()+90
            while not (root/'mcp-stop').exists():
                assert time.monotonic()<deadline,'UI synchronization did not finish'
                await asyncio.sleep(0.1)
try: asyncio.run(main())
finally: (root/'mcp-transcript.json').write_text(json.dumps(transcript,indent=2))
`;

try {
  receipt.build = await buildIdentity();
  assert.equal(receipt.build.manifest.sourceRevision, env.LOCI_QA_SOURCE_COMMIT);
  assert.equal(receipt.build.manifest.sourceDirty, false);
  receipt.harness_sha256 = await sha(import.meta.filename);
  const fixture = await oracle('setup'); receipt.fixture = fixture;
  const module = wasmModule();
  await writeJson(packagePath, { schema: 'loci.controlled-method-package/v1', manifest: {
    schema: 'loci.controlled-method/v1', id: 'packaged-authored-technical', version: '1.0.0', abi: 'loci-method-buffers/v1',
    module: { sha256: digest(module), bytes: module.length }, rights: { license: 'Apache-2.0', source: 'Loci authored packaged QA fixture', use_basis: 'Technical QA only; no scientific validation' },
    metrics: [{ id: 'pixel_count', kind: 'measurement', unit: 'pixel', description: 'Authored exact sampled label pixel count' },
      { id: 'fixture_score', kind: 'prediction', unit: 'probability', description: 'Authored technical score, not calibrated biological probability' }] }, module_base64: module.toString('base64') });
  const values = Buffer.alloc(36); values.write('LOCIMO01'); values.writeUInt32LE(1, 8); values.writeUInt32LE(2, 12);
  values.writeUInt32LE(1, 16); values.writeDoubleLE(64, 20); values.writeDoubleLE(0.375, 28); await fs.writeFile(outputPath, values);
  picker = { study, openStudy: study, source, package: packagePath, methodOutput: outputPath,
    inputs: inputArchive, archive: portable, restored, exported: path.join(output, 'export-method'), agentBundle: path.join(output, 'agent-access') };
  await launch(1); await createEmptyStudy(page);
  await page.getByRole('button', { name: 'Add images', exact: true }).click();
  const initial = await wait(snapshot, s => s.sources.length === 1, 'authored source import');
  const src = initial.sources[0]; assert.equal(src.sha256, fixture.source_sha256);
  const recipe = { source_id: src.id, selection, recipe: { segmentation: { method: 'components', threshold: 50 }, measurement_channels: [0, 1], working_bytes: 64 * 1024**2 } };
  const parent = await task('run_recipe', recipe); assert.equal(parent.object_count, 1);
  const method = await api('importControlledMethod'); assert.equal(method.module_sha256, digest(module));
  assert.equal(method.rights_status, 'not-reviewed'); receipt.method = method;
  await denied('method_import', { path: packagePath }, /native|Unknown|operation/iu);
  const request = { ...binding(parent), method_id: method.method_id, manifest_sha256: method.manifest_sha256,
    module_sha256: method.module_sha256, raw_channels: [1, 0], working_bytes: 64 * 1024**2 };
  const flight = await execute('method_preflight', request); assert.deepEqual(flight.preflight.label_ids, [1]);
  assert.deepEqual(flight.preflight.input_binding.selection, selection); assert.deepEqual(flight.preflight.input_binding.raw_channels, [1, 0]);
  const input = { ...request, preflight_hash: flight.preflight_hash };
  const exportedInput = await api('exportControlledMethodInput', [input]); assert.equal(exportedInput.execution, 'not-performed');
  receipt.input_oracle = await oracle('input', { source_sha256: src.sha256, parent,
    input_sha256: flight.preflight.input_sha256, preflight: flight.preflight, module_sha256: method.module_sha256 });
  await denied('method_preflight', { ...request, revision_hash: '0'.repeat(64) }, /stale|revision/iu);
  await api('reviewControlledMethodRights', [{ method_id: method.method_id, manifest_sha256: method.manifest_sha256,
    module_sha256: method.module_sha256, decision: 'approved', reviewer: 'Automated authored-fixture QA',
    evidence: 'Harness-authored Apache-2.0 technical module; explicitly simulated native confirmation, no scientific review' }]);
  const runtime = await execute('method_runtime'); assert.equal(runtime.available, false); assert.equal(runtime.execution_available, false);
  await denied('method_run', { ...input, mode: 'execute' }, /Linux|confinement|runtime|implemented/iu);
  const grant = await api('chooseControlledMethodOutput', [input]); assert.equal(grant.output_sha256, digest(values));
  await fs.appendFile(outputPath, Buffer.from([0]));
  await assert.rejects(() => api('chooseControlledMethodOutput', [input]), /output|length|size|bytes/iu);
  // The original native grant owns immutable copied bytes. Later changes to
  // the external file must neither change those values nor revoke that copy.
  const run = { ...input, mode: 'adopt-external', output_grant_id: grant.output_grant_id };
  const methodResult = await task('method_run', run);
  const query = await execute('method_query', { ...binding(methodResult), offset: 0, limit: 100 });
  assert.deepEqual(query.rows, [{ label_id: 1, values: [64, 0.375] }]); assert.equal(query.origin, 'adopted-external');
  receipt.checks.push('data-only-native-import-exact-ABI-export-macOS-execute-refused-invalid-output-refused-owned-copy-values-adopted');

  const annotationState = await execute('source_annotations', { source_id: src.id });
  const annotation = await execute('annotate_source', { source_id: src.id, source_sha256: src.sha256,
    expected_revision: annotationState.revision, action: 'add', annotation: { kind: 'rectangle',
      points: [{ x: 4, y: 4 }, { x: 12, y: 4 }, { x: 12, y: 12 }, { x: 4, y: 12 }],
      label: 'Authored technical reference square', color: '#aabbcc', z: 1, t: 0 } });
  const candidates = await execute('annotation_reference_candidates', { ...binding(methodResult), offset: 0, limit: 100 });
  assert.equal(candidates.total, 1); assert.equal(candidates.source_annotations_revision, annotation.revision);
  const freeze = { ...binding(methodResult), source_annotations_revision: annotation.revision,
    annotation_ids: candidates.candidates.map(a => a.id), semantics: 'instances', coverage_declaration: 'Complete authored 32x32 crop; exact 8x8 reference square', working_bytes: 64 * 1024**2 };
  await denied('annotation_reference_run', { ...freeze, source_annotations_revision: annotation.revision + 1 }, /changed|revision/iu);
  const reference = await task('annotation_reference_run', freeze);
  const compare = { ...binding(methodResult), reference: binding(reference), semantics: 'instances', iou_thresholds: [0.5, 0.75],
    reference_declaration: 'Authored complete technical reference; no biological ground truth claim', working_bytes: 64 * 1024**2 };
  const agreement = await task('annotation_evaluation_run', compare);
  const report = await execute('annotation_evaluation_get', { ...binding(agreement), table: 'summary' });
  assert.equal(report.annotation_evaluation.metrics.region.iou, 1); assert.equal(report.annotation_evaluation.metrics.region.dice, 1);
  const matches = await execute('annotation_evaluation_get', { ...binding(agreement), table: 'matches', threshold_index: 0, offset: 0, limit: 1 });
  assert.equal(matches.total, 1); assert.deepEqual(matches.rows, [{ reference_label: 1, prediction_label: 1, intersection_pixels: 64, union_pixels: 64, iou: 1 }]);

  // Observe the actual durable task before asking its native cancellation API.
  const beforeCancel = await snapshot();
  const pending = execute('annotation_evaluation_run', compare).then(value => ({ value }), error => ({ error: error.message }));
  const live = await wait(async () => {
    const current = await snapshot();
    return current.jobs.find(j => !beforeCancel.jobs.some(old => old.id === j.id));
  }, Boolean, 'new cancellation target');
  if (['queued', 'running'].includes(live.state)) {
    const requested = await api('cancelJob', [live.id]); const finished = await pending;
    const end = await wait(snapshot, s => ['cancelled', 'succeeded', 'failed', 'interrupted'].includes(s.jobs.find(j => j.id === live.id)?.state), 'exact native cancellation outcome');
    const terminal = end.jobs.find(j => j.id === live.id);
    if (terminal.state === 'cancelled') {
      assert.deepEqual(terminal.result_ids, []); assert.deepEqual(end.results.map(binding), beforeCancel.results.map(binding));
      receipt.cancellation = { covered: true, observed_job: live.id, observed_state: live.state,
        final_state: 'cancelled', cancel_response: requested, response: finished };
    } else {
      assert.equal(terminal.state, 'succeeded', 'Cancellation neither cancelled nor preserved an already-published result');
      assert.equal(terminal.result_ids.length, 1);
      receipt.cancellation = { covered: false, observed_job: live.id, observed_state: live.state,
        final_state: terminal.state, cancel_response: requested, response: finished,
        reason: 'Durable publication won the race before cancellation was applied; no cancellation acceptance is claimed' };
    }
  } else {
    await pending; receipt.cancellation = { observed_job: live.id, final_state: live.state, covered: false,
      reason: 'Technical task completed before an active cancellation target was observable' };
  }

  // A second real source is never interchangeable with the reference despite equal array shape.
  picker.source = alternate; await installPickers(); await api('addSources', ['files']);
  const other = (await snapshot()).sources.find(s => s.id !== src.id); assert.ok(other);
  const otherResult = await task('run_recipe', { ...recipe, source_id: other.id });
  await denied('annotation_evaluation_run', { ...compare, reference: binding(otherResult) }, /exact source|grid|source|crop/iu);

  const access = await api('createAgentAccess', [{ ...recipe,
    permission_mode: 'full_access', allow_preview: false, allow_run: true, allow_export: false, export_names: [],
    delegation: { client_id: 'packaged-method-annotation-qa', expires_at: null, result_scope: 'granted-sources', allow_review: false },
    actions: ['method_query', 'annotation_evaluation_run', 'annotation_evaluation_get'],
    source_scope: { mode: 'study-sources', sources: [{ id: src.id, sha256: src.sha256 }] },
    disclosures: ['geometry', 'source_names', 'previews', 'measurements', 'provenance', 'agent_metadata'],
    limits: { cpu_seconds: 30, memory_bytes: 128 * 1024**2, concurrency: 1 } }]);
  receipt.agent_access = access;
  const mcpConfig = path.join(output, 'mcp-client-input.json');
  await writeJson(mcpConfig, { output, worker, config: path.join(picker.agentBundle, access.config_filename),
    method: binding(methodResult), comparison: compare, outside: { ...compare, reference: binding(otherResult) } });
  let mcpFinished;
  mcpPending = exec(python, ['-c', mcpCode, mcpConfig], { cwd: output, timeout: 150000, maxBuffer: 4 * 1024**2 })
    .then(value => { mcpFinished = { ok: true, value }; return mcpFinished; }, error => { mcpFinished = { ok: false, error: error.stack ?? String(error) }; return mcpFinished; });
  receipt.mcp = await wait(async () => {
    if (mcpFinished) throw new Error('Packaged MCP client ended before screenshot readiness: ' + JSON.stringify(mcpFinished));
    return json(path.join(output, 'mcp-ready.json')).catch(() => null);
  }, Boolean, 'real packaged MCP session and completed agreement', 45000);

  for (const [name, result] of Object.entries({ method: methodResult, agreement })) {
    picker.exported = path.join(output, 'export-' + name); await installPickers();
    await assert.rejects(() => api('exportResult', [result.id, result.revision_hash]), /review/iu);
    await api('reviewResult', [result.id, result.revision_hash, 'reviewed']);
    await api('exportResult', [result.id, result.revision_hash]);
  }
  await api('exportStudy'); receipt.portable_sha256 = await sha(portable);
  receipt.array_oracle = await oracle('exports', { results: { method: methodResult, agreement } });
  const imported = await api('importStudy'); assert.ok(imported.results.some(r => r.id === agreement.id));
  receipt.before_cold = await snapshot();

  // Reopen using ordinary UI so React adopts the actual updated bridge snapshot.
  picker.openStudy = study; await installPickers(); await refreshStudy(); await chooseResult(methodResult);
  await selectWorkbenchTool(page, 'Analyze');
  const disclosure = page.locator('details.external-labels-disclosure').filter({ has: page.locator('summary').filter({ hasText: /^Reusable methods$/u }) });
  await disclosure.locator(':scope > summary').click();
  await page.getByRole('region', { name: 'Controlled reusable methods', exact: true }).waitFor(); await shot('01-packaged-reusable-methods');
  await selectWorkbenchTool(page, 'Annotate'); await page.getByRole('region', { name: 'Annotation agreement', exact: true }).waitFor();
  await shot('02-packaged-annotation-agreement-panel');
  await chooseResult(agreement); await selectWorkbenchTool(page, 'Info'); await selectResultSection(page, 'Review');
  await page.getByRole('region', { name: 'Saved annotation agreement', exact: true }).waitFor(); await shot('03-packaged-saved-agreement');
  await page.getByRole('button', { name: 'Agent session status', exact: true }).click();
  await page.getByLabel('Agent session and approvals', { exact: true }).waitFor();
  const connected = await wait(snapshot, s => s.agent_sessions?.connected_count > 0, 'actual connected MCP session');
  receipt.agent_drawer_snapshot = connected.agent_sessions;
  await shot('04-actual-agent-drawer');
  await page.getByRole('button', { name: 'Close agent session drawer', exact: true }).click();
  await fs.writeFile(path.join(output, 'mcp-stop'), 'stop\n');
  const mcpEnd = await mcpPending; assert.equal(mcpEnd.ok, true, JSON.stringify(mcpEnd)); mcpPending = undefined;
  await close();

  await fs.rename(source, offline); await fs.rename(alternate, alternate + '.offline');
  picker.openStudy = restored; await launch(2);
  await page.getByRole('button', { name: 'Open study', exact: true }).click();
  const cold = await wait(snapshot, s => s?.results.some(r => r.id === agreement.id), 'fresh-profile portable retained reopen');
  assert.equal(cold.jobs.length, receipt.before_cold.jobs.length, 'Cold reopen reran a task');
  for (const result of [methodResult, reference, agreement]) {
    const saved = cold.results.find(r => r.id === result.id); assert.equal(saved.revision_hash, result.revision_hash); assert.deepEqual(saved.arrays, result.arrays);
    await execute('result', { result_id: result.id });
  }
  const coldMethod = await execute('method_query', { ...binding(methodResult), offset: 0, limit: 100 }); assert.deepEqual(coldMethod.rows, query.rows);
  const coldReport = await execute('annotation_evaluation_get', { ...binding(agreement), table: 'summary' }); assert.deepEqual(coldReport, report);
  await chooseResult(agreement); await selectWorkbenchTool(page, 'Info'); await selectResultSection(page, 'Review'); await shot('05-cold-portable-source-offline');
  receipt.cold = { fresh_profile: true, raw_sources_offline: true, decoder_instrumented: false,
    exact_revisions_arrays_and_reports: true, no_new_jobs: true, result_ids: [methodResult.id, reference.id, agreement.id] };
  await close(); await fs.rename(offline, source); await fs.rename(alternate + '.offline', alternate);
  assert.deepEqual(await buildIdentity(), receipt.build); assert.equal(await sha(source), fixture.source_sha256);
  assert.deepEqual(receipt.network_requests, []); assert.deepEqual(receipt.renderer_errors, []);
  receipt.checks.push('exact-reviewed-method-and-agreement-export-arrays', 'independent-pixel-instance-oracle',
    'portable-live-authority-stripped', 'fresh-profile-retained-reads-with-source-unavailable', 'actual-method-annotation-and-agent-drawer-ui');
  receipt.status = 'passed';
} catch (error) {
  failure = error; receipt.status = 'failed'; receipt.error = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    await shot('failure').catch(() => {});
    await writeJson(path.join(output, 'failure-snapshot.json'), await snapshot().catch(() => null));
    await fs.writeFile(path.join(output, 'failure-page.html'), await page.content().catch(() => ''));
  }
} finally {
  if (mcpPending) {
    await fs.writeFile(path.join(output, 'mcp-stop'), 'stop\n');
    const stopped = await mcpPending; if (!stopped.ok) { receipt.mcp_error = stopped.error; receipt.status = 'failed'; failure ??= new Error(stopped.error); }
  }
  await close().catch(error => { receipt.cleanup_error = error.stack ?? String(error); receipt.status = 'failed'; failure ??= error; });
  for (const [from, to] of [[offline, source], [alternate + '.offline', alternate]])
    if (await fs.stat(from).then(() => true, () => false)) await fs.rename(from, to).catch(error => { receipt.fixture_restore_error = error.message; failure ??= error; receipt.status = 'failed'; });
  receipt.finished_at = new Date().toISOString(); await writeJson(path.join(output, 'receipt.json'), receipt);
  console.log(JSON.stringify({ status: receipt.status, receipt: path.join(output, 'receipt.json') }));
}
if (failure) throw failure;
