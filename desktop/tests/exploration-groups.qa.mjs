import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { fileMenuAction, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
assert.equal(process.platform, "darwin");
assert.ok(process.env.LOCI_PACKAGED_APP, "Choose the exact separate candidate");
const bundle = await fs.realpath(process.env.LOCI_PACKAGED_APP);
const executable = path.join(bundle, "Contents/MacOS/Loci");
const worker = path.join(bundle, "Contents/Resources/loci-engine/loci-engine");
const asar = path.join(bundle, "Contents/Resources/app.asar");
const startedAt = new Date().toISOString();
const runRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(root, ".loci/qa"), "exploration-groups-" + startedAt.replaceAll(/[:.]/g, "-"));
const userData = path.join(runRoot, "user-data"), fixtureRoot = path.join(runRoot, "fixtures");
const study = path.join(runRoot, "exploration.loci-study"), archive = path.join(runRoot, "portable-study.zip");
const python = path.join(root, "engine/.venv/bin/python"), oracleScript = path.join(root, "scripts/fixtures/exploration_groups_qa.py");
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(path.join(runRoot,"downloads"),{recursive:true});
const hash = async file => { const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest("hex"); };
const identity = async () => ({ executable_sha256: await hash(executable), worker_sha256: await hash(worker), asar_sha256: await hash(asar) });
const build = await identity();
const git = async (...args) => (await run("git", args, { cwd: root })).stdout.trim();
const source = { head: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"), status: await git("status", "--porcelain"), harness_sha256: await hash(path.join(import.meta.dirname, "exploration-groups.qa.mjs")), oracle_sha256: await hash(oracleScript) };
const fixture = JSON.parse((await run(python, [oracleScript, "create", "--root", fixtureRoot], { cwd: root })).stdout);
const assertions = {}, checkpoints = [], records = {};
let app, page;
async function launch() {
  app = await electron.launch({ executablePath: executable, args: ["--user-data-dir=" + userData], cwd: path.join(root, "desktop"), timeout: 120000 });
  page = await app.firstWindow();
  if (process.env.LOCI_QA_BACKGROUND === "1") await app.evaluate(({ app, BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setFocusable(false); window.blur(); } app.hide(); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 940 }));
  await app.evaluate(({ dialog, session }, values) => {
    session.defaultSession.on("will-download", (_event, item) => {
      globalThis.lociDownloadCount = (globalThis.lociDownloadCount ?? 0) + 1;
      item.setSavePath(values.downloads + "/" + globalThis.lociDownloadCount + "-" + item.getFilename().replace(/[\\/]/g,"_"));
    });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      return title === "Add microscopy or medical images" ? { canceled: false, filePaths: [values.source] } : title === "Open research study" ? { canceled: false, filePaths: [values.study] } : { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      return { canceled: !["Save research study as", "Export portable study with derived results"].includes(title), filePath: title === "Save research study as" ? values.study : values.archive };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source: path.join(fixtureRoot, fixture.source), study, archive, downloads:path.join(runRoot,"downloads") });
}
const snapshot = () => page.evaluate(() => window.lociResearch.getSnapshot());
const inspect = id => page.evaluate(result_id => window.lociResearch.execute("result", { result_id, limit: 1000 }), id);
const groups = () => page.evaluate(() => window.lociResearch.execute("population_group_list", {}));
async function wait(read, predicate, message, timeout=30000) { const end = Date.now()+timeout; while(Date.now()<end) { const value=await read(); if(predicate(value)) return value; await page.waitForTimeout(100); } throw new Error(message); }
async function shot(name) { const viewport=page.locator(".image-viewport:visible"); if(await viewport.count()) { await wait(()=>viewport.first().getAttribute("data-prepared"),value=>value==="true","source frame not ready for screenshot"); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); } await page.screenshot({ path:path.join(runRoot,name+".png"),fullPage:true }); checkpoints.push(name); process.stdout.write("Checkpoint: "+name+"\n"); }
async function field(label, value) { const input=page.getByLabel(label,{exact:true}); await input.fill(String(value)); await input.press("Enter"); }
async function region(x,y,width,height) { for(const [key,value] of Object.entries({width,height,x,y})) await field("Exploration ROI "+key,value); }
async function gateBounds(values) { for (const [index,label] of ["X minimum","X maximum","Y minimum","Y maximum"].entries()) await page.getByLabel("Gate "+label,{exact:true}).fill(String(values[index])); }
async function evaluate(count) { await page.getByRole("button",{name:"Evaluate gate on all objects",exact:true}).click(); await page.getByText(`${count} of 3 objects in highlighted membership.`,{exact:false}).waitFor(); }
async function saveGroup(name) { await page.getByLabel("Population group name",{exact:true}).fill(name); await page.getByRole("button",{name:"Save fixed group & gate",exact:true}).click(); return await wait(groups,value=>value.groups.some(item=>item.name===name),"group not saved"); }
async function close() { if(app) { await app.close(); app=undefined; } }
try {
  await launch();
  await page.getByRole("button",{name:"Open images",exact:true}).click();
  const initial = await waitForSnapshot(page,value=>value?.sources?.length===1,"synthetic source");
  const src=initial.sources[0]; assert.equal(src.sha256,fixture.source_sha256);
  await selectWorkbenchTool(page,"Analyze");
  const exploration=page.getByRole("region",{name:"Guided segmentation exploration"});
  await exploration.locator(".exploration-region-editor > summary").click();
  await region(0,0,64,64);
  await field("Setting 1 threshold","invalid");
  assert.equal(await exploration.getByRole("button",{name:"Preview setting 1",exact:true}).isEnabled(),false);
  await shot("00-invalid-numeric-recovery");
  await field("Setting 1 threshold",65535);
  await exploration.getByRole("button",{name:"Preview setting 1",exact:true}).click();
  await exploration.getByText("0 objects in draft preview. No result has been adopted.",{exact:true}).waitFor();
  await shot("00b-empty-preview");
  assertions.invalid_numeric_and_empty_preview_recovery=true;
  for (const [index, threshold] of [64,128,192].entries()) await field(`Setting ${index+1} threshold`,threshold);
  for(const [x,y,width,height] of [[0,0,64,64],[4,4,56,56],[8,8,48,48]]) { await region(x,y,width,height); await exploration.getByRole("button",{name:/Add current ROI/}).click(); }
  await exploration.getByRole("button",{name:"Compare 3 regions × 3 settings",exact:true}).click();
  await exploration.locator(".exploration-contact-sheet article").nth(8).waitFor();
  assert.equal(await exploration.locator(".exploration-contact-sheet article").count(),9);
  assert.equal((await snapshot()).results.length,0,"Comparison must not adopt a result");
  await exploration.getByRole("button",{name:"Enlarge parameter comparison",exact:true}).click();
  const comparisonDialog=page.getByRole("dialog",{name:"Parameter comparison",exact:true});
  assert.equal(await comparisonDialog.locator("article").count(),9);
  await shot("01-comparison-large-dark");
  await page.getByRole("button",{name:"Close parameter comparison",exact:true}).click();
  await exploration.getByRole("button",{name:"Download comparison record",exact:true}).click();
  await wait(()=>fs.readdir(path.join(runRoot,"downloads")),files=>files.some(file=>file.endsWith("loci-exploration.json")),"exact comparison download");
  // Use region 1, setting 1: all three known objects on the declared64x64 crop.
  await exploration.locator(".exploration-contact-sheet article").first().getByRole("button",{name:"Adopt this region",exact:true}).click();
  const adopted=await waitForSnapshot(page,value=>value?.results?.length===1,"exact preview adoption");
  const result=adopted.results[0]; assert.equal(result.object_count,3);
  const before=await inspect(result.id); records.before=before;
  assert.equal(before.provenance.exploration.software_identity.kind,"frozen-executable-sha256");
  assert.equal(before.provenance.exploration.software_identity.sha256,build.worker_sha256);
  assert.ok(adopted.jobs.filter(job=>job.operation.startsWith("exploration_")).every(job=>job.request_key.startsWith("exploration:")));
  assert.deepEqual(before.measurements.map(row=>row.measure),[16,36,64]);
  assertions.unsaved_preview_compare_exact_adoption=true;
  await selectWorkbenchTool(page,"Population");
  await page.getByRole("table",{name:"Population object table"}).waitFor();
  const population=await page.evaluate(({id,revision})=>window.lociResearch.execute("population_query",{result_id:id,revision_hash:revision}),{id:result.id,revision:result.revision_hash});
  const intensity=population.metrics.find(metric=>metric.kind==="intensity" && metric.statistic==="mean"); assert.ok(intensity);
  await page.getByLabel("Population X metric",{exact:true}).selectOption("measure");
  await page.getByLabel("Population Y metric",{exact:true}).selectOption(intensity.id);
  await page.getByRole("button",{name:"Gates & named groups",exact:true}).click();
  await page.getByLabel("Population gate tool",{exact:true}).selectOption("rectangle");
  const plot = page.locator(".population-groups svg.population-scatter");
  await plot.scrollIntoViewIfNeeded();
  let bounds = await plot.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x+bounds.width*0.35,bounds.y+bounds.height*0.3); await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width*0.75,bounds.y+bounds.height*0.65,{steps:5}); await page.mouse.up();
  assert.notEqual(await page.getByLabel("Gate X minimum",{exact:true}).inputValue(),"");
  await gateBounds([16,36,100,160]); await evaluate(2); await saveGroup("Small");
  await page.getByRole("button",{name:"Download exact membership record",exact:true}).click();
  await wait(()=>fs.readdir(path.join(runRoot,"downloads")),files=>files.some(file=>file.endsWith("loci-population-group.json")),"exact group download");
  await wait(()=>page.locator('[data-group-highlight-count="2"]').count(),n=>n>0,"linked image highlights absent");
  await shot("02-rectangle-linked-highlight");
  await page.getByLabel("Population gate tool",{exact:true}).selectOption("polygon");
  await plot.scrollIntoViewIfNeeded(); bounds = await plot.boundingBox();
  for (const [x,y] of [[0.3,0.3],[0.7,0.3],[0.6,0.6]]) await page.mouse.click(bounds.x+bounds.width*x,bounds.y+bounds.height*y);
  assert.equal((await page.getByLabel("Gate polygon vertices",{exact:true}).inputValue()).split("\n").length,3);
  await page.getByLabel("Gate polygon vertices",{exact:true}).fill("0,0\n70,0\n70,230\n0,230"); await evaluate(3); await saveGroup("All");
  await page.getByLabel("Combine group Small",{exact:true}).check();
  await page.getByLabel("Population group name",{exact:true}).fill("Remainder");
  await page.getByRole("button",{name:"Save unclassified",exact:true}).click();
  await wait(groups,value=>value.groups.some(item=>item.name==="Remainder"),"complement absent");
  await page.getByRole("button",{name:"Highlight Remainder",exact:true}).click();
  await wait(()=>page.locator('[data-group-highlight-count="1"]').count(),n=>n>0,"complement highlight absent");
  records.groups=(await groups()).groups;
  assertions.rectangle_polygon_complete_memberships_and_complement=true;
  // Display edits remain in Results and are preserved through Annotate.
  const channelControls=page.getByRole("group",{name:"Channel display controls",exact:true});
  await channelControls.getByLabel("Signal B visible",{exact:true}).check();
  await channelControls.getByRole("button",{name:"Solo",exact:true}).click();
  assert.equal(await channelControls.getByLabel("Signal B visible",{exact:true}).isChecked(),false);
  await channelControls.getByRole("button",{name:"Restore",exact:true}).click();
  assert.equal(await channelControls.getByLabel("Signal B visible",{exact:true}).isChecked(),true);
  await channelControls.getByLabel("Signal B visible",{exact:true}).uncheck();
  await channelControls.getByLabel("Display channel",{exact:true}).selectOption("0");
  await field("Signal A low",20); await field("Signal A high",200);
  const view=await wait(()=>page.evaluate(source_id=>window.lociResearch.execute("source_view",{source_id}),src.id),value=>value.state?.channels?.find(ch=>ch.channel===0)?.low===20,"display state not saved");
  assert.equal(view.state.channels.find(ch=>ch.channel===1).visible,false);
  await selectWorkbenchTool(page,"Annotate");
  assert.equal(await page.getByLabel("Signal A low",{exact:true}).inputValue(),"20");
  await selectWorkbenchTool(page,"Population");
  assert.deepEqual(await inspect(result.id),before,"Display edits changed scientific state");
  assertions.persistent_display_raw_invariance=true;
  await shot("03-groups-display-large-dark");
  // Inspect real native dimensions and keyboard focus without replacing product state.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1024,height:720}));
  await page.keyboard.press("Tab"); await shot("04-narrow-keyboard-dark");
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,focused:document.activeElement?.getAttribute("aria-label")}));
  assert.ok(layout.scroll<=layout.width+1,"App has horizontal overflow");
  records.layout=layout;
  await page.getByRole("button",{name:"Open settings",exact:true}).click();
  await page.getByRole("tab",{name:"Appearance",exact:true}).click();
  await page.getByLabel("Application theme",{exact:true}).selectOption("paper");
  await page.getByRole("button",{name:"Close settings",exact:true}).click();
  await shot("04b-narrow-paper");
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1600,height:1000}));
  await shot("04c-large-paper");
  assertions.narrow_large_dark_light_and_keyboard_observed=true;
  // Exercise the existing raw compartment engine through the new guide.
  await selectWorkbenchTool(page,"Analyze");
  await page.locator(".exploration-region-editor > summary").click();
  await region(0,0,64,64);
  await field("Setting 1 threshold",192);
  await page.getByRole("button",{name:"Preview setting 1",exact:true}).click();
  await page.locator(".exploration-contact-sheet article").first().waitFor();
  await page.getByRole("button",{name:"Adopt this region",exact:true}).click();
  const paired=await waitForSnapshot(page,value=>value?.results?.length===2,"synthetic subset revision");
  const nucleus=paired.results.find(item=>item.id!==result.id); assert.equal(nucleus.object_count,1);
  await page.locator(`button[data-result-id="${result.id}"]`).click();
  await selectWorkbenchTool(page,"Population");
  await page.locator(".population-measurement-guide > summary").click();
  await page.getByRole("button",{name:"Connect nucleus & cell results",exact:true}).click();
  await page.getByRole("heading",{name:"Cell compartments",exact:true}).waitFor();
  await page.getByLabel("Nuclei result",{exact:true}).selectOption(nucleus.id);
  await page.getByLabel("Cells result",{exact:true}).selectOption(result.id);
  await page.getByLabel("Nuclei role declaration",{exact:true}).fill("Synthetic subset");
  await page.getByLabel("Cells role declaration",{exact:true}).fill("Synthetic objects");
  await page.getByLabel("Association controls and assumptions",{exact:true}).fill("Mathematical nested masks; no biological segmentation claim.");
  await page.getByRole("checkbox",{name:/^Measure compartment channel 1:/}).check();
  await page.getByRole("button",{name:"Measure compartments",exact:true}).click();
  const associated=await waitForSnapshot(page,value=>value?.results?.some(item=>item.kind==="nucleus-cell-association"),"raw compartment measurements");
  const compartments=associated.results.find(item=>item.kind==="nucleus-cell-association");
  records.compartments=await inspect(compartments.id);
  assert.deepEqual(records.compartments.measurements.map(row=>row.compartments.nuclear.measure),[0,0,64]);
  assert.deepEqual(records.compartments.measurements.map(row=>row.compartments.cytoplasm.measure),[16,36,0]);
  await selectWorkbenchTool(page,"Population");
  await page.getByLabel("Population X metric",{exact:true}).selectOption("compartment:nuclear:measure");
  await page.getByLabel("Population Y metric",{exact:true}).selectOption("compartment:cytoplasm:measure");
  await page.getByRole("button",{name:"Gates & named groups",exact:true}).click();
  assert.equal(await page.getByText("No named groups on this revision yet.",{exact:true}).count(),1);
  await page.getByLabel("Population gate tool",{exact:true}).selectOption("rectangle");
  await gateBounds([64,64,0,0]); await evaluate(1); await saveGroup("Nuclear-high");
  await page.getByLabel("Population group name",{exact:true}).fill("Small-compartments");
  await page.getByText("Apply a saved gate to this result",{exact:true}).click();
  await page.getByRole("button",{name:"Apply Small as new group",exact:true}).click();
  const reapplied=await wait(groups,value=>value.groups.some(item=>item.name==="Small-compartments"),"reapplied gate creates a new evaluated group");
  const originalGroup=reapplied.groups.find(item=>item.name==="Small"), newGroup=reapplied.groups.find(item=>item.name==="Small-compartments");
  assert.notEqual(originalGroup.id,newGroup.id); assert.equal(newGroup.result_id,compartments.id); assert.equal(newGroup.included_count,2);
  await shot("04d-compartment-group-exact-revision");
  records.groups=(await groups()).groups;
  assertions.guided_raw_compartment_measurement_conservation_and_group=true;
  await fileMenuAction(page,"Save study");
  await wait(()=>fs.stat(path.join(study,"study.sqlite3")).catch(()=>null),Boolean,"study not saved");
  await selectWorkbenchTool(page,"Portability");
  await page.getByRole("button",{name:"Export portable study",exact:true}).click();
  await wait(()=>fs.stat(archive).catch(()=>null),Boolean,"portable export absent");
  await close(); await launch();
  await Promise.race([page.locator("main.image-first-empty").waitFor(),page.locator("main.image-first-workbench").waitFor()]);
  if(await page.locator("main.image-first-empty").isVisible()) await page.getByRole("button",{name:"Open study",exact:true}).click();
  const reopened=await waitForSnapshot(page,value=>value?.results?.some(item=>item.id===result.id),"cold reopen exact result");
  assert.equal(reopened.results.find(item=>item.id===result.id).revision_hash,result.revision_hash);
  assert.deepEqual((await groups()).groups,records.groups,"Cold reopen changed group records");
  await page.locator(`button[data-result-id="${result.id}"]`).click(); await selectWorkbenchTool(page,"Population");
  await page.getByRole("button",{name:"Gates & named groups",exact:true}).click();
  await page.getByRole("button",{name:"Highlight Small",exact:true}).click();
  await wait(()=>page.locator('[data-group-highlight-count="2"]').count(),n=>n>0,"cold reopen highlight absent");
  assert.equal(await page.getByLabel("Signal A low",{exact:true}).inputValue(),"20");
  await shot("05-cold-reopen-groups");
  assertions.graphical_rectangle_polygon_and_keyboard_geometry=true;
  // A separate managed session exercises a real larger population; the saved
  // small-oracle study and its portable archive remain unchanged.
  await fileMenuAction(page,"Recent work");
  await page.locator("main.image-first-empty").waitFor();
  await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},path.join(fixtureRoot,fixture.large_source));
  await page.getByRole("button",{name:"Open images",exact:true}).click();
  await waitForSnapshot(page,value=>value?.sources?.some(item=>item.sha256===fixture.large_source_sha256),"large synthetic source");
  await selectWorkbenchTool(page,"Analyze");
  await field("Setting 1 threshold",64);
  await page.getByRole("button",{name:"Preview setting 1",exact:true}).click();
  await page.getByRole("button",{name:"Cancel exploration",exact:true}).click();
  await waitForSnapshot(page,value=>value?.jobs?.some(job=>job.operation==="exploration_preview" && job.state==="cancelled"),"owned native preview cancellation",60000);
  await wait(()=>page.getByRole("button",{name:"Preview setting 1",exact:true}).isEnabled(),Boolean,"cancelled preview recovered");
  assert.equal((await snapshot()).results.length,0);
  assertions.unique_task_key_cancellation_and_recovery=true;
  const startedLarge=performance.now();
  await page.getByRole("button",{name:"Preview setting 1",exact:true}).click();
  await page.locator(".exploration-contact-sheet article").first().waitFor({timeout:60000});
  await page.getByRole("button",{name:"Adopt this region",exact:true}).click();
  const largeSnapshot=await waitForSnapshot(page,value=>value?.results?.some(item=>item.object_count===10000),"10000 object adoption",120000);
  const largeResult=largeSnapshot.results.find(item=>item.object_count===10000);
  await selectWorkbenchTool(page,"Population");
  await page.getByRole("table",{name:"Population object table"}).waitFor();
  await page.getByLabel("Population X metric",{exact:true}).selectOption("measure");
  await page.getByLabel("Population Y metric",{exact:true}).selectOption("voxel_count");
  await page.getByRole("button",{name:"Gates & named groups",exact:true}).click();
  await page.getByLabel("Population gate tool",{exact:true}).selectOption("rectangle");
  await gateBounds([4,4,4,4]);
  const startedGate=performance.now();
  await page.getByRole("button",{name:"Evaluate gate on all objects",exact:true}).click();
  await page.getByText("10,000 of 10,000 objects in highlighted membership.",{exact:false}).waitFor({timeout:60000});
  await wait(()=>page.locator('[data-group-highlight-count="10000"]').count(),n=>n>0,"full large-population highlight");
  records.performance={object_count:10000,scatter_display_count:await page.locator(".population-groups circle[data-point-label]").count(),gate_to_highlight_ms:performance.now()-startedGate,preview_adoption_and_query_ms:performance.now()-startedLarge,process_metrics:await app.evaluate(({app})=>app.getAppMetrics())};
  assert.equal(records.performance.scatter_display_count,500);
  const complete=await page.evaluate(({id,revision})=>window.lociResearch.execute("population_query",{result_id:id,revision_hash:revision,plot_limit:500}),{id:largeResult.id,revision:largeResult.revision_hash});
  assert.equal(complete.total_count,10000); assert.equal(complete.scatter.sampled,true);
  await shot("06-complete-large-population-highlight");
  assertions.real_10000_object_evaluation_and_complete_highlight=true;
  // Exercise Finding 1: valid calibrated preview with identical calibrated areas
  await fileMenuAction(page, "Recent work");
  await page.locator("main.image-first-empty").waitFor();
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, path.join(fixtureRoot, fixture.calibrated_source));
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await waitForSnapshot(page, value => value?.sources?.some(item => item.sha256 === fixture.calibrated_source_sha256), "calibrated synthetic source");
  await selectWorkbenchTool(page, "Analyze");
  await field("Setting 1 threshold", 64);
  await field("Setting 1 minimum area", 0.5);
  await page.getByRole("button", { name: "Preview setting 1", exact: true }).click();
  await page.locator(".exploration-contact-sheet article").first().waitFor({ timeout: 30000 });
  await page.getByText("3 objects in draft preview.", { exact: false }).waitFor({ timeout: 10000 });
  assert.match(await page.locator(".exploration-contact-sheet article").first().innerText(),
    /3 objects · mean 0\.75 um\^2/, "Calibrated repeated-area mean must remain 0.75 um^2");
  await shot("07-calibrated-repeated-areas-preview");
  assertions.calibrated_repeated_areas_preview_succeeded = true;
  // Exercise Finding 2: two-source study with unavailable unrelated source
  const twoSourceStudy = path.join(runRoot, "two-source.loci-study");
  await fileMenuAction(page, "Recent work");
  await page.locator("main.image-first-empty").waitFor();
  await app.evaluate(({ dialog }, { sources, savePath }) => {
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      return title === "Add microscopy or medical images"
        ? { canceled: false, filePaths: sources }
        : { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath });
  }, { sources: [path.join(fixtureRoot, fixture.source), path.join(fixtureRoot, fixture.second_source)], savePath: twoSourceStudy });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const twoSourceSnap = await waitForSnapshot(page, value => value?.sources?.length === 2, "two sources loaded");
  const sSignals = twoSourceSnap.sources.find(s => s.sha256 === fixture.source_sha256);
  const sSecond = twoSourceSnap.sources.find(s => s.sha256 === fixture.second_source_sha256);
  assert.ok(sSignals && sSecond);
  await page.locator(`.research-sources button[data-source-id="${sSecond.id}"]`).click();
  await selectWorkbenchTool(page, "Analyze");
  await field("Setting 1 threshold", 64);
  await page.getByRole("button", { name: "Preview setting 1", exact: true }).click();
  await page.locator(".exploration-contact-sheet article").first().waitFor({ timeout: 30000 });
  await page.locator(".exploration-contact-sheet article").first().getByRole("button", { name: "Adopt this region", exact: true }).click();
  const snapSec = await waitForSnapshot(page, value => value?.results?.some(r => r.source_id === sSecond.id), "second source result");
  const resSec = snapSec.results.find(r => r.source_id === sSecond.id);
  await selectWorkbenchTool(page, "Population");
  await page.getByRole("table", { name: "Population object table" }).waitFor();
  await page.getByLabel("Population X metric", { exact: true }).selectOption("measure");
  await page.getByLabel("Population Y metric", { exact: true }).selectOption("voxel_count");
  await page.getByRole("button", { name: "Gates & named groups", exact: true }).click();
  await page.getByLabel("Population gate tool", { exact: true }).selectOption("rectangle");
  await gateBounds([1, 100, 1, 100]);
  await page.getByRole("button", { name: "Evaluate gate on all objects", exact: true }).click();
  await page.getByText("objects in highlighted membership.", { exact: false }).waitFor();
  await saveGroup("Group-Second");
  await page.locator(`.research-sources button[data-source-id="${sSignals.id}"]`).click();
  await selectWorkbenchTool(page, "Analyze");
  await field("Setting 1 threshold", 64);
  await page.getByRole("button", { name: "Preview setting 1", exact: true }).click();
  await page.locator(".exploration-contact-sheet article").first().waitFor({ timeout: 30000 });
  await page.locator(".exploration-contact-sheet article").first().getByRole("button", { name: "Adopt this region", exact: true }).click();
  const snapSig = await waitForSnapshot(page, value => value?.results?.some(r => r.source_id === sSignals.id), "signals source result");
  const resSig = snapSig.results.find(r => r.source_id === sSignals.id);
  await selectWorkbenchTool(page, "Population");
  await page.getByRole("table", { name: "Population object table" }).waitFor();
  await page.getByLabel("Population X metric", { exact: true }).selectOption("measure");
  await page.getByLabel("Population Y metric", { exact: true }).selectOption("voxel_count");
  await page.getByRole("button", { name: "Gates & named groups", exact: true }).click();
  await page.getByLabel("Population gate tool", { exact: true }).selectOption("rectangle");
  await gateBounds([1, 100, 1, 100]);
  await page.getByRole("button", { name: "Evaluate gate on all objects", exact: true }).click();
  await page.getByText("objects in highlighted membership.", { exact: false }).waitFor();
  await saveGroup("Group-Signals");
  await fileMenuAction(page, "Save study");
  await wait(() => fs.stat(path.join(twoSourceStudy, "study.sqlite3")).catch(() => null), Boolean, "two-source study not saved");
  const secondPath = path.join(fixtureRoot, fixture.second_source);
  const movedPath = secondPath + ".moved";
  await fs.rename(secondPath, movedPath);
  try {
    const rawGroupList = await page.evaluate(() => window.lociResearch.execute("population_group_list", {}));
    const grpSignals = rawGroupList.groups.find(g => g.name === "Group-Signals");
    const grpSecond = rawGroupList.groups.find(g => g.name === "Group-Second");
    assert.ok(grpSignals && grpSecond);
    assert.equal(grpSignals.source_available, true);
    assert.equal(grpSecond.source_available, false);
    await page.locator(`button[data-result-id="${resSig.id}"]`).click();
    await page.getByRole("table", { name: "Population object table" }).waitFor();
    await page.getByRole("button", { name: "Gates & named groups", exact: true }).click();
    await page.getByRole("button", { name: "Highlight Group-Signals", exact: true }).click();
    await wait(() => page.locator('[data-group-highlight-count="3"]').count(), n => n > 0, "intact group highlight failed");
    assert.equal(await page.getByLabel("Combine group Group-Signals", { exact: true }).isEnabled(), true);
    await page.getByLabel("Population group name", { exact: true }).fill("Group-Second-Applied");
    await page.getByText("Apply a saved gate to this result", { exact: true }).click();
    await page.getByRole("button", { name: "Apply Group-Second as new group", exact: true }).click();
    const afterApply = await wait(groups, val => val.groups.some(g => g.name === "Group-Second-Applied"), "reapplied gate creates group");
    const appliedGroup = afterApply.groups.find(g => g.name === "Group-Second-Applied");
    const appliedRecord = await page.evaluate(id => window.lociResearch.execute("population_group_get", { group_id: id }), appliedGroup.id);
    assert.deepEqual(appliedRecord.membership.labels, [1, 2, 3], "Reusable gate evaluates all exact target objects");
    assert.equal(appliedRecord.membership.result_id, resSig.id);
    assert.equal(appliedRecord.membership.revision_hash, resSig.revision_hash);
    records.reapplied_gate_membership = appliedRecord.membership;
    await page.getByRole("button", { name: "Download exact membership record", exact: true }).click();
    const directFetchFailed = await page.evaluate(async (id) => {
      try {
        await window.lociResearch.execute("population_group_get", { group_id: id });
        return false;
      } catch {
        return true;
      }
    }, grpSecond.id);
    assert.ok(directFetchFailed, "direct fetch of unavailable group must fail");
    const directCombineFailed = await page.evaluate(async ({ binding, id }) => {
      try {
        await window.lociResearch.execute("population_group_combine", { ...binding, group_ids: [id], name: "Invalid-Combine", mode: "union" });
        return false;
      } catch {
        return true;
      }
    }, { binding: { result_id: resSig.id, revision_hash: resSig.revision_hash, source_id: sSignals.id, source_sha256: sSignals.sha256 }, id: grpSecond.id });
    assert.ok(directCombineFailed, "direct combine of unavailable group must fail");
    await shot("08-two-source-unavailable-isolated");
    assertions.two_source_unavailable_isolation_and_reusable_gates = true;
  } finally {
    await fs.rename(movedPath, secondPath);
  }
  await close();
  const oracle=JSON.parse((await run(python,[oracleScript,"verify","--root",fixtureRoot,"--study",study,"--archive",archive],{cwd:root,timeout:60000})).stdout);
  assert.equal(oracle.status,"passed"); assertions.exact_save_export_cold_reopen=true;
  assert.deepEqual(await identity(),build);
  await fs.writeFile(path.join(runRoot,"inspected-records.json"),JSON.stringify(records,null,2)+"\n");
  const receipt={schema:"loci.exploration-groups-packaged-qa/v1",status:"passed",started_at:startedAt,finished_at:new Date().toISOString(),build,source,fixture,assertions,oracle,checkpoints,invocation:{app_bundle:bundle,output_root:runRoot},limitations:"Synthetic macOS engineering journey; biological accuracy and independent usability untested"};
  await fs.writeFile(path.join(runRoot,"receipt.json"),JSON.stringify(receipt,null,2)+"\n"); process.stdout.write(JSON.stringify(receipt,null,2)+"\n");
}catch(error){
  if(page) { await shot("failure").catch(()=>{}); await fs.writeFile(path.join(runRoot,"failure-ui.txt"),await page.locator("body").innerText().catch(()=>"unavailable")); }
  await fs.writeFile(path.join(runRoot,"receipt.json"),JSON.stringify({status:"failed",started_at:startedAt,build,source,assertions,checkpoints,error:String(error)},null,2)+"\n"); throw error;
}finally{await close();}
