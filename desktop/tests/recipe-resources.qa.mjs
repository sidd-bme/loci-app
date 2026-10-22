/** Packaged whole-image recipe allowance, numerical and persistence regression. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { selectResultSection, selectWorkbenchTool } from './workbench-qa-helpers.mjs';
const repo=path.resolve(import.meta.dirname, '../..');
const bundle=process.env.LOCI_PACKAGED_APP;
assert.ok(bundle, 'Set LOCI_PACKAGED_APP to the exact qualification candidate');
const root=path.join(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repo,'.loci/evidence/recipe-resources'),new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(root,{recursive:true});
const fixture=path.join(root,'synthetic-3000.ome.tif');
const generator=path.join(root,'fixture.py');
await fs.writeFile(generator, `from pathlib import Path
import numpy as np
import tifffile
a=np.zeros((3000,3000),dtype=np.uint16)
a[100:116,200:220]=100
a[400:425,500:540]=200
tifffile.imwrite(Path(__file__).parent/'synthetic-3000.ome.tif',a,tile=(256,256),ome=True,photometric='minisblack',metadata={'axes':'YX','PhysicalSizeX':0.5,'PhysicalSizeXUnit':'µm','PhysicalSizeY':0.75,'PhysicalSizeYUnit':'µm'})
`);
execFileSync(path.join(repo,'engine/.venv/bin/python'),[generator]);
const study=path.join(root,'resource-study.loci-study');
const exported=path.join(root,'reviewed-larger-recipe');
const sha=async(p)=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const report={head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 kind:'packaged synthetic larger recipe / recovery / save-reopen', fixture_sha256:await sha(fixture),
 identity:{executable:await sha(path.join(bundle,'Contents/MacOS/Loci')),
 asar:await sha(path.join(bundle,'Contents/Resources/app.asar')),
 worker:await sha(path.join(bundle,'Contents/Resources/loci-engine/loci-engine')),harness:await sha(import.meta.filename)},screenshots:[],errors:[]};
const app=await electron.launch({executablePath:path.join(bundle,'Contents/MacOS/Loci'),args:[`--user-data-dir=${path.join(root,'user-data')}`],cwd:path.join(repo,'desktop'),timeout:60000});
const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){const value=await check();if(value)return value;await page.waitForTimeout(80);}throw new Error('Timed out: '+label);}
async function capture(name){const p=path.join(root,name+'.png');await page.screenshot({path:p});report.screenshots.push({path:p,sha256:await sha(p)});}
try{
 await app.evaluate(({dialog,BrowserWindow},{fixture,study,exported})=>{
  BrowserWindow.getAllWindows()[0].setBounds({x:20,y:40,width:1280,height:900});
  dialog.showOpenDialog=async(...args)=>({canceled:false,filePaths:[args.at(-1)?.title==='Open research study'?study:fixture]});
  dialog.showSaveDialog=async(...args)=>({canceled:false,filePath:args.at(-1)?.title==='Export reviewed result bundle'?exported:study});
 },{fixture,study,exported});
 await page.getByRole('button',{name:'Open images',exact:true}).click();
 await page.getByRole('button',{name:'Analyze',exact:true}).click();
 await page.getByRole('button',{name:'Whole image',exact:true}).click();
 await page.getByLabel('Threshold',{exact:true}).fill('50');
 await page.getByText('892.64 MiB',{exact:true}).waitFor({timeout:30000});
 assert.equal(await page.getByLabel('Recipe memory allowance').inputValue(),String(512*1024**2));
 await page.getByLabel('Recipe memory allowance').focus();
 assert.equal(await page.getByLabel('Recipe memory allowance').evaluate(node=>node===document.activeElement),true);
 await capture('01-estimate-and-keyboard-focus');
 await page.getByRole('button',{name:'Run recipe',exact:true}).click();
 await page.locator('.research-alert').filter({hasText:'larger explicit allowance'}).waitFor();
 assert.equal((await page.evaluate(()=>window.lociResearch.getSnapshot())).results.length,0);
 await page.getByLabel('Recipe memory allowance').selectOption(String(1024**3));
 await page.getByText('892.64 MiB',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Run recipe',exact:true}).click();
 await until(async()=>((await page.evaluate(()=>window.lociResearch.getSnapshot()))?.results.length??0)===1,'published result');
 await until(()=>page.getByRole('button',{name:'Run recipe',exact:true}).isEnabled(),'run returned');
 const result=await page.evaluate(async()=>{const s=await window.lociResearch.getSnapshot();return window.lociResearch.execute('result',{result_id:s.results[0].id});});
 const rows=result.measurements.sort((a,b)=>a.voxel_count-b.voxel_count);
 assert.deepEqual(rows.map(r=>[r.voxel_count,r.measure,Object.values(r.intensity)[0].mean]),[[320,120,100],[1000,375,200]]);
 assert.equal(result.provenance.recipe.working_bytes,1024**3);
 await page.locator('button[data-result-id]').click();
 await selectWorkbenchTool(page,'Info');
 await page.locator("details.research-preview-rows > summary").click();
 await until(()=>page.getByRole('region',{name:'Result measurements',exact:true}).locator('tbody tr').count().then(n=>n===2),'two displayed measurement rows');
 await page.waitForFunction(()=>{
   const v=document.querySelector('.image-viewport[data-result-overlay]');
   const c=v?.querySelector('canvas'); if(!c)return false;
   const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
   for(let i=0;i<pixels.length;i+=4)if(pixels[i]!==pixels[i+1]||pixels[i+1]!==pixels[i+2])return true;
   return false;
 });
 assert.equal(await page.locator('.research-alert').count(),0);
 await capture('04-larger-result-and-measurements');
 await selectResultSection(page, "Review"); await page.getByRole('button',{name:'Mark reviewed',exact:true}).click();
 await selectResultSection(page, "Export"); await page.getByRole('button',{name:'Export result',exact:true}).click();
 await until(()=>fs.stat(path.join(exported,'manifest.json')).then(()=>true,()=>false),'atomic reviewed export');
 const exportRecord=JSON.parse(await fs.readFile(path.join(exported,'result.json'),'utf8'));
 assert.equal(exportRecord.result.provenance.recipe.working_bytes,1024**3);
 assert.equal(exportRecord.result.provenance.recipe_sha256,result.provenance.recipe_sha256);
 assert.equal(exportRecord.source.sha256,report.fixture_sha256);
 const manifest=JSON.parse(await fs.readFile(path.join(exported,'manifest.json'),'utf8'));
 for(const file of manifest.files)assert.equal(await sha(path.join(exported,file.name)),file.sha256);
 const oracle=path.join(root,'export-oracle.py');
 await fs.writeFile(oracle, `from pathlib import Path
import numpy as np
import tifffile
root=Path(__file__).parent
source=tifffile.imread(root/'synthetic-3000.ome.tif')
image=tifffile.imread(root/'reviewed-larger-recipe/image.ome.tif')
labels=tifffile.imread(root/'reviewed-larger-recipe/labels.ome.tif')
assert image.shape == labels.shape == (3000,3000)
assert np.array_equal(image,source)
assert sorted(np.count_nonzero(labels==i) for i in np.unique(labels) if i) == [320,1000]
assert labels[100:116,200:220].min() > 0 and labels[400:425,500:540].min() > 0
print('Exact exported intensity array and independently constructed label regions passed')
`);
 report.export_oracle=execFileSync(path.join(repo,'engine/.venv/bin/python'),[oracle],{encoding:'utf8'}).trim();
 report.export_manifest_sha256=await sha(path.join(exported,'manifest.json'));
 await page.getByRole('button',{name:'Save study',exact:true}).click();
 await until(()=>fs.stat(path.join(study,'study.sqlite3')).then(()=>true,()=>false),'saved study');
 await until(async()=>await page.locator('main.image-first-workbench').getAttribute('aria-busy')!=='true','save document lock released');
 await page.getByText('File',{exact:true}).click();
 await page.getByRole('button',{name:'Open study',exact:true}).click();
 await until(async()=>await page.locator('main.image-first-workbench').getAttribute('aria-busy')!=='true','open document lock released');
 const restored=await page.evaluate(async()=>{const s=await window.lociResearch.getSnapshot();return window.lociResearch.execute('result',{result_id:s.results[0].id});});
 assert.equal(restored.provenance.recipe_sha256,result.provenance.recipe_sha256);
 assert.equal(await sha(fixture),report.fixture_sha256);
 await page.getByRole('button',{name:'Analyze',exact:true}).click();
 await page.getByLabel('Recipe memory allowance').selectOption(String(8*1024**3));
 await page.getByText(/Above this computer’s recommended allowance/).waitFor();
 const native=await app.browserWindow(page);await native.evaluate(w=>w.setBounds({width:1024,height:720}));
 await page.getByRole('region',{name:'Recipe resources',exact:true}).scrollIntoViewIfNeeded();
 await capture('02-small-window-larger-allowance');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>{document.documentElement.dataset.theme='paper';document.documentElement.dataset.textSize='large';});
 await capture('03-paper-large-text');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.locator('.research-alert').count(),0);
 report.passed=['whole image accurate estimate','keyboard focus','lower allowance refuses with actionable error and no result','explicit 1 GiB UI run yields independent numerical oracle','visible result overlay and two measurement rows','reviewed export retains allowance/source/recipe hashes and exact numerical arrays','save and reopen retains budget/hash','source bytes unchanged','8 GiB remains selectable above hardware recommendation','1024x720 and Paper large text no page overflow'];
 report.result={objects:rows.map(r=>({pixels:r.voxel_count,area:r.measure,mean:Object.values(r.intensity)[0].mean})),recipe_sha256:result.provenance.recipe_sha256,working_bytes:result.provenance.recipe.working_bytes};
 report.status='passed';assert.equal(report.errors.length,0);
}catch(e){report.status='failed';report.failure=e.stack||String(e);await capture('failure').catch(()=>{});process.exitCode=1;}
finally{await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');await app.close();}
console.log(JSON.stringify({root,status:report.status,failure:report.failure}));
