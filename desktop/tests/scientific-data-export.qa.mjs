import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile), root = path.resolve(import.meta.dirname,"../..");
assert.equal(process.platform,"darwin");
assert.ok(process.env.LOCI_PACKAGED_APP,"Choose the exact separate candidate app");
const bundle = await fs.realpath(process.env.LOCI_PACKAGED_APP), executable = path.join(bundle,"Contents/MacOS/Loci");
const python = path.join(root,"engine/.venv/bin/python"), fixtureScript=path.join(root,"scripts/fixtures/scientific_export_qa.py");
const startedAt = new Date().toISOString(), runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(root,".loci/qa"),"scientific-export-"+startedAt.replaceAll(/[:.]/g,"-"));
await fs.mkdir(runRoot,{recursive:true});
const hash=async file=>{const h=createHash("sha256"); for await(const bytes of createReadStream(file))h.update(bytes);return h.digest("hex");};
const identity=async()=>({executable_sha256:await hash(executable),asar_sha256:await hash(path.join(bundle,"Contents/Resources/app.asar")),worker_sha256:await hash(path.join(bundle,"Contents/Resources/loci-engine/loci-engine"))});
const build=await identity(), git=async(...args)=>(await run("git",args,{cwd:root})).stdout.trim();
const source={head:await git("rev-parse","HEAD"),tree:await git("rev-parse","HEAD^{tree}"),status:await git("status","--porcelain"),harness_sha256:await hash(path.join(import.meta.dirname,"scientific-data-export.qa.mjs")),fixture_script_sha256:await hash(fixtureScript)};
const setup=JSON.parse((await run(python,[fixtureScript,"create","--directory",path.join(runRoot,"fixture")],{cwd:root,timeout:120000,maxBuffer:4*1024**2})).stdout);
const fixture=JSON.parse(await fs.readFile(setup.manifest,"utf8")), before=path.join(runRoot,"scientific-before.json");
await run(python,[fixtureScript,"snapshot","--manifest",setup.manifest,"--output",before],{cwd:root});
const packages={}, checkpoints=[], assertions={}, observations={}; let app,page;
const wait=async(read,test,message,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(test(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(message);};
const panel=()=>page.getByRole("region",{name:"Export scientific data",exact:true});
const snapshot=()=>page.evaluate(()=>window.lociResearch.getSnapshot());
async function shot(name){assert.equal(await page.locator(".recoverable-error").count(),0,"Unexpected global error before "+name);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(runRoot,name+".png"),fullPage:true});checkpoints.push(name);process.stdout.write("Checkpoint: "+name+"\n");}
async function selectResult(name){const value=fixture.results[name]??fixture.method_results[name];await page.locator(`button[data-source-id="${value.source_id}"]`).click();await page.locator(`[data-result-id="${value.result_id}"]`).click();await selectWorkbenchTool(page,"Info");await panel().waitFor();await panel().getByLabel("Data export result scope",{exact:true}).selectOption("current");await panel().getByLabel("Data export object scope",{exact:true}).selectOption("all");await panel().getByLabel("Data export purpose",{exact:true}).selectOption("reviewed");return value;}
async function prepared(){await panel().getByRole("button",{name:"Preview data",exact:true}).click();await panel().getByRole("heading",{name:"Prepared scope",exact:true}).waitFor({timeout:120000});}
async function destination(name){const target=path.join(runRoot,name);await app.evaluate((_electron,value)=>{globalThis.scientificExportDestination=value;},target);return target;}
async function workerMemory(){try{const ids=(await run("pgrep",["-f",path.join(bundle,"Contents/Resources/loci-engine/loci-engine")])).stdout.trim().split(/\s+/).filter(value=>/^\d+$/.test(value));if(!ids.length)return[];const raw=(await run("ps",["-o","pid=,rss=","-p",ids.join(",")])).stdout;return raw.trim().split("\n").filter(Boolean).map(line=>{const [pid,rss_kib]=line.trim().split(/\s+/).map(Number);return{pid,rss_kib};});}catch{return[];}}
async function exported(name){const target=await destination(name),started=performance.now(),samples=[];let monitoring=true;const monitor=(async()=>{while(monitoring){samples.push({elapsed_ms:performance.now()-started,processes:await workerMemory()});await new Promise(resolve=>setTimeout(resolve,100));}})();try{await panel().getByRole("button",{name:"Export data package…",exact:true}).click();await panel().getByText(new RegExp("^Saved "+name+" ·")).waitFor({timeout:120000});await fs.access(path.join(target,"manifest.json"));packages[name]=target;return target;}finally{monitoring=false;await monitor;observations.exports??={};observations.exports[name]={elapsed_ms:performance.now()-started,worker_rss_samples:samples,peak_aggregate_worker_rss_kib:Math.max(0,...samples.map(sample=>sample.processes.reduce((sum,process)=>sum+process.rss_kib,0))),electron_process_metrics:await app.evaluate(({app})=>app.getAppMetrics())};}}
async function oracle(mode,target){return JSON.parse((await run(python,[fixtureScript,"verify","--manifest",setup.manifest,"--mode",mode,"--package",target],{cwd:root,timeout:60000,maxBuffer:4*1024**2})).stdout);}
async function readers(target){const py=await run(python,["-B",path.join(target,"read_data.py"),target],{cwd:root,timeout:60000,maxBuffer:4*1024**2});const r=await run("Rscript",[path.join(target,"read_data.R"),target],{cwd:root,timeout:60000,maxBuffer:4*1024**2});return {python:py.stdout,r:r.stdout};}
async function launch(){app=await electron.launch({executablePath:executable,args:["--user-data-dir="+path.join(runRoot,"user-data")],cwd:path.join(root,"desktop"),timeout:120000});page=await app.firstWindow();if(process.env.LOCI_QA_BACKGROUND==="1")await app.evaluate(({app,BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows()){win.setFocusable(false);win.blur();}app.hide();});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1440,height:940}));await app.evaluate(({dialog},study)=>{dialog.showOpenDialog=async(...args)=>args.at(-1)?.title==="Open research study"?{canceled:false,filePaths:[study]}:{canceled:true,filePaths:[]};dialog.showSaveDialog=async(...args)=>args.at(-1)?.title==="Export scientific data package"?{canceled:false,filePath:globalThis.scientificExportDestination}:{canceled:true};dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});},setup.study_path);}
try{
  await launch();await page.getByRole("button",{name:"Open study",exact:true}).click();
  await waitForSnapshot(page,value=>Object.values(fixture.results).every(result=>value?.results?.some(item=>item.id===result.result_id)),"authored exact result revisions");
  const initial=await snapshot();observations.initial_review=Object.fromEntries(initial.results.map(item=>[item.id,item.review??null]));
  await selectResult("A");
  // The first cold planning request is cancellable; no file grant exists yet.
  await panel().getByRole("button",{name:"Preview data",exact:true}).click();
  const cancel=panel().getByRole("button",{name:"Cancel data export",exact:true});
  await cancel.waitFor();await shot("00-planning-loading");await cancel.click();
  await panel().getByText("Preparation cancelled. No package was written.",{exact:true}).waitFor();
  await wait(()=>panel().getByRole("button",{name:"Preview data",exact:true}).isEnabled(),Boolean,"cancelled planning did not recover");
  assert.equal((await fs.readdir(runRoot)).some(name=>name.startsWith(".loci-data-")),false);
  assertions.request_owned_planning_cancel=true;
  await prepared();await shot("01-reviewed-exact-preview");
  await panel().getByRole("region",{name:/^Data preview for/}).first().scrollIntoViewIfNeeded();await shot("01b-reviewed-exact-table");
  const reviewed=await exported("reviewed-A"); observations.reviewed=await oracle("reviewedA",reviewed);observations.readers=await readers(reviewed);
  const provenance=JSON.parse(await fs.readFile(path.join(reviewed,"provenance.json"),"utf8"));assert.equal(provenance.export_software.kind,"frozen-executable-sha256");assert.equal(provenance.export_software.sha256,build.worker_sha256);
  await panel().getByLabel("Data export object scope",{exact:true}).selectOption("groups");
  await panel().getByRole("checkbox",{name:"Small · 2 objects",exact:true}).check();await panel().getByRole("checkbox",{name:"High · 2 objects",exact:true}).check();
  await prepared();await shot("02-overlapping-groups-preview");
  observations.group_union=await oracle("A-groupunion",await exported("group-union"));
  assertions.reviewed_csv_and_complete_overlap=true;
  await selectResult("B");await panel().getByRole("button",{name:"Preview data",exact:true}).click();
  await panel().getByRole("alert").filter({hasText:"Reviewed data requires"}).waitFor();await shot("03-pending-review-blocked");
  await panel().getByRole("button",{name:"Use Provisional data for review",exact:true}).click();
  assert.equal(await panel().getByLabel("Data export purpose",{exact:true}).inputValue(),"provisional");
  assert.deepEqual((await snapshot()).results.find(row=>row.id===fixture.results.B.result_id).review??null,observations.initial_review[fixture.results.B.result_id]);
  assertions.explicit_provisional_recovery_preserves_pending_review=true;
  await panel().getByLabel("Data export result scope",{exact:true}).selectOption("study");
  const choices=panel().getByRole("group",{name:"Exact result revisions",exact:true});
  for(const box of await choices.getByRole("checkbox").all())await box.uncheck();
  for(const value of Object.values(fixture.results))await choices.locator("label").filter({hasText:value.revision_hash}).getByRole("checkbox").check();
  await prepared();await panel().getByText(/^Mixed measurement units are present/).waitFor();
  await shot("04-mixed-unit-study-preview");
  await panel().getByRole("region",{name:/^Data preview for/}).first().scrollIntoViewIfNeeded();await shot("04b-mixed-unit-table");
  observations.study=await oracle("allprovisional",await exported("provisional-study"));
  const after=await snapshot();for(const result of after.results)assert.deepEqual(result.review??null,observations.initial_review[result.id],"Export must not grant review");
  assertions.explicit_study_scope_review_status_units_replicates_preserved=true;
  // Study export foundation: inspection may change the active result, but
  // it must retain the exact study draft and per-revision group selections.
  for(const box of await choices.getByRole("checkbox").all())await box.uncheck();
  for(const name of ["A","B"])await choices.locator("label").filter({hasText:fixture.results[name].revision_hash}).getByRole("checkbox").check();
  await panel().getByLabel("Data export object scope",{exact:true}).selectOption("groups");
  const small=()=>panel().getByRole("checkbox",{name:"Small · 2 objects",exact:true});
  const high=()=>panel().getByRole("checkbox",{name:"High · 2 objects",exact:true});
  await small().check();await high().check();
  async function retainedDraft(){
    assert.equal(await panel().getByLabel("Data export result scope",{exact:true}).inputValue(),"study");
    assert.equal(await panel().getByLabel("Data export purpose",{exact:true}).inputValue(),"provisional");
    assert.equal(await panel().getByLabel("Data export object scope",{exact:true}).inputValue(),"groups");
    for(const name of ["A","B"])assert.equal(await panel().getByRole("group",{name:"Exact result revisions",exact:true}).locator("label").filter({hasText:fixture.results[name].revision_hash}).getByRole("checkbox").isChecked(),true);
    assert.equal(await small().isChecked(),true);assert.equal(await high().isChecked(),true);
    assert.equal(await panel().getByRole("heading",{name:"Prepared scope",exact:true}).count(),0,"Navigation must not resurrect a prepared export plan");
  }
  for(const name of ["A","B"]){
    const exact=fixture.results[name];
    await panel().getByRole("button",{name:"Inspect rev "+exact.revision_hash.slice(0,8),exact:true}).click();
    await wait(()=>page.locator(`[data-result-id="${exact.result_id}"]`).getAttribute("aria-pressed"),value=>value==="true","Exact inspected result");
    assert.equal(await page.locator(`button[data-source-id="${exact.source_id}"]`).getAttribute("aria-current"),"true");
    await retainedDraft();
  }
  await panel().getByRole("button",{name:"Create group in Statistics & objects",exact:true}).click();
  await selectWorkbenchTool(page,"Info");await panel().waitFor();await retainedDraft();
  const foundationAfter=await snapshot();
  for(const result of foundationAfter.results)assert.deepEqual(result.review??null,observations.initial_review[result.id]);
  await shot("04c-inspect-retains-study-groups-review");
  assertions.exact_inspect_study_group_draft_tab_return_and_no_review_bypass=true;
  await selectResult("C");await panel().getByLabel("Data export purpose",{exact:true}).selectOption("provisional");await prepared();
  await panel().getByText("This scope contains zero objects. The package will retain its empty tables, schemas and provenance.",{exact:true}).waitFor();
  const empty=await exported("empty-data");const emptySchema=JSON.parse(await fs.readFile(path.join(empty,"schema.json"),"utf8"));assert.equal(emptySchema.tables["objects.csv"].row_count,0);await readers(empty);
  await panel().getByText("This scope contains zero objects. The package will retain its empty tables, schemas and provenance.",{exact:true}).scrollIntoViewIfNeeded();await shot("05-zero-objects-export");assertions.empty_schema_package=true;
  await selectResult("D");
  for (const route of ["panel", "jobs"]) {
    await prepared(); const cancelledDestination=await destination("cancelled-large-"+route);
    await panel().getByRole("button",{name:"Export data package…",exact:true}).click();
    const running = await waitForSnapshot(page,value=>value?.jobs?.find(job=>job.operation==="scientific_data_export"&&job.state==="running"),"running native export before "+route+" cancellation");
    const jobId = running.jobs.find(job=>job.operation==="scientific_data_export"&&job.state==="running").id;
    await wait(()=>fs.readdir(runRoot),names=>names.some(name=>name.startsWith(".loci-data-")),"owned export stage before "+route+" cancellation");
    if (route === "jobs") {
      await page.getByRole("button",{name:/^Jobs/}).click();
      const tray=page.getByRole("region",{name:"Job center",exact:true});
      const row=tray.locator(".workbench-jobs__row").filter({hasText:"scientific data export"}).filter({has:page.getByRole("button",{name:"Cancel",exact:true})});
      await row.getByRole("button",{name:"Cancel",exact:true}).click();
      await shot("05b-jobs-tray-cancelling");
      await waitForSnapshot(page,value=>value?.jobs?.some(job=>job.id===jobId&&job.state==="cancelled"),"Jobs tray cooperative cancellation");
      await shot("05c-jobs-tray-cancelled");
      await tray.getByRole("button",{name:"Close Job Center",exact:true}).click();
    } else {
      await panel().getByRole("button",{name:"Cancel data export",exact:true}).click();
      await waitForSnapshot(page,value=>value?.jobs?.some(job=>job.id===jobId&&job.state==="cancelled"),"panel cooperative cancellation");
    }
    await wait(()=>panel().getByRole("button",{name:"Preview data",exact:true}).isEnabled(),Boolean,"cancelled export did not recover");
    assert.equal(await fs.stat(cancelledDestination).then(()=>true,()=>false),false,"Cancelled export published a package");
    assert.equal((await fs.readdir(runRoot)).some(name=>name.startsWith(".loci-data-")),false,"Cancelled export left its owned stage");
    observations[route+"_cancel"]={job_id:jobId,state:(await snapshot()).jobs.find(job=>job.id===jobId),destination_absent:true,owned_stage_removed:true};
  }
  assertions.native_large_export_cancel_no_publication_and_recovery=true;
  assertions.general_jobs_tray_cooperative_cancel_and_cleanup=true;
  await panel().getByLabel("Data export object scope",{exact:true}).selectOption("groups");
  await panel().getByRole("checkbox",{name:"Selected600 · 600 objects",exact:true}).check();await prepared();
  const started=performance.now();const large=await exported("large-600");observations.large={export_ms:performance.now()-started,process_metrics:await app.evaluate(({app})=>app.getAppMetrics()),oracle:await oracle("large600",large)};
  await readers(large);await shot("06-complete-600-member-export");assertions.exact_subset_larger_than_chart_sample=true;
  // Replay Cancel after actual publication: success and its visible receipt survive.
  const completedJob=(await snapshot()).jobs.filter(job=>job.operation==="scientific_data_export"&&job.state==="succeeded").sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
  const manifestBeforeLateCancel=await hash(path.join(large,"manifest.json"));
  const lateCancellation=await page.evaluate(id=>window.lociResearch.cancelJob(id),completedJob.id);
  assert.equal(lateCancellation.state,"succeeded"); assert.equal(lateCancellation.cancel_requested,false);
  assert.equal(await hash(path.join(large,"manifest.json")),manifestBeforeLateCancel);
  await panel().getByText(/^Saved large-600 ·/).waitFor();
  observations.post_publication_cancel={job_id:completedJob.id,state:lateCancellation.state,receipt_still_visible:true,manifest_unchanged:true};
  assertions.post_publication_cancel_preserves_success_and_receipt=true;
  // Native no-replace error then recovery, while retaining the existing package.
  const priorManifest=await hash(path.join(large,"manifest.json"));await destination("large-600");await panel().getByRole("button",{name:"Export data package…",exact:true}).click();
  const destinationError=panel().getByRole("alert").filter({hasText:/absent|overwrite|already exists/});
  await destinationError.waitFor();await destinationError.scrollIntoViewIfNeeded();
  assert.equal(/invoking remote|loci-research/.test(await destinationError.innerText()),false);
  assert.equal(await hash(path.join(large,"manifest.json")),priorManifest);await shot("07-existing-destination-error");await prepared();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1024,height:720}));
  await panel().getByRole("button",{name:"Preview data",exact:true}).focus();await page.keyboard.press("Tab");
  const focusedExport=panel().getByRole("button",{name:"Export data package…",exact:true});
  assert.equal(await focusedExport.evaluate(el=>document.activeElement===el&&el.matches(":focus-visible")),true);
  await focusedExport.scrollIntoViewIfNeeded();await shot("08-laptop-keyboard-dark");
  await panel().getByRole("region",{name:/^Data preview for/}).first().scrollIntoViewIfNeeded();await shot("08b-laptop-exact-table");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.getByRole("button",{name:"Open settings",exact:true}).click();await page.getByRole("tab",{name:"Appearance",exact:true}).click();await page.getByLabel("Application theme",{exact:true}).selectOption("paper");await page.getByRole("button",{name:"Close settings",exact:true}).click();
  await shot("09-laptop-paper");await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1600,height:1000}));await shot("10-large-paper");
  assertions.no_replace_error_recovery_keyboard_laptop_themes=true;
  observations.methods={};
  for(const [name, expected] of Object.entries(fixture.method_provenance)) {
    await selectResult(name); await panel().getByLabel("Data export purpose",{exact:true}).selectOption("provisional");
    await prepared(); const target=await exported("method-"+name.toLowerCase());
    const text=await fs.readFile(path.join(target,"provenance.json"),"utf8"), data=JSON.parse(text);
    const actual=data.results[0].scientific_provenance[expected.field];
    assert.deepEqual(actual,expected.expected); assert.equal(text.includes("/private/authored-control-not-for-export"),false);
    observations.methods[name]={field:expected.field,settings:actual,readers:await readers(target)};
  }
  assert.equal(observations.methods.Tissue.settings.closing_radius_pixels,2);
  assert.equal(observations.methods.Tissue.settings.minimum_component_pixels,20);
  assertions.executed_tissue_stain_rgb_puncta_settings_and_readers=true;
  const final=await snapshot();assert.ok(final.jobs.some(job=>job.operation==="scientific_data_export"&&job.state==="succeeded"));
  assert.ok(final.jobs.filter(job=>job.operation==="scientific_data_export").every(job=>job.request_key.startsWith("scientific-export:")));
  await app.close();app=undefined;
  observations.immutability=JSON.parse((await run(python,[fixtureScript,"unchanged","--manifest",setup.manifest,"--snapshot",before],{cwd:root})).stdout);
  assert.equal(observations.immutability.immutable_files,"passed");assert.equal(observations.immutability.scientific_state,"passed");
  assert.deepEqual(await identity(),build);
  await fs.writeFile(path.join(runRoot,"observations.json"),JSON.stringify(observations,null,2)+"\n");
  const receipt={schema:"loci.scientific-data-export-packaged-qa/v1",status:"passed",started_at:startedAt,finished_at:new Date().toISOString(),build,source,fixture_manifest:setup.manifest,packages,assertions,checkpoints,limitations:"Authored synthetic macOS engineering journey; no biological/cross-platform/usability validation"};
  await fs.writeFile(path.join(runRoot,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");process.stdout.write(JSON.stringify(receipt,null,2)+"\n");
}catch(error){if(page&&app){await shot("failure").catch(()=>{});await fs.writeFile(path.join(runRoot,"failure-ui.txt"),await page.locator("body").innerText().catch(()=>"unavailable"));}await fs.writeFile(path.join(runRoot,"observations.json"),JSON.stringify(observations,null,2)+"\n");await fs.writeFile(path.join(runRoot,"receipt.json"),JSON.stringify({status:"failed",started_at:startedAt,build,source,checkpoints,assertions,error:String(error)},null,2)+"\n");throw error;}finally{if(app)await app.close();}
