/** Packaged publisher-graph journey. The lead runs this with the secondary-display loader.
 * Dialog responses are simulated. All import, inspection, plane and save actions use the UI.
 * LOCI_PACKAGED_APP, LOCI_QA_OUTPUT_ROOT (new directory), LOCI_QA_ORGANOID_FIXTURE
 * (the prepared publisher pair), LOCI_QA_SOURCE_COMMIT, LOCI_QA_SECONDARY_DISPLAY.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { close, launch, plainFile, requiredPath, sha256 } from "./research-model-workbench.qa.mjs";
import { createEmptyStudy, fileMenuAction, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

assert.equal(process.platform, "darwin");
assert.ok(process.env.LOCI_QA_SECONDARY_DISPLAY && process.env.NODE_OPTIONS?.includes("secondary-display-loader.mjs"));
const bundle = requiredPath("LOCI_PACKAGED_APP"), fixture = requiredPath("LOCI_QA_ORGANOID_FIXTURE");
const out = requiredPath("LOCI_QA_OUTPUT_ROOT");
const source = path.join(fixture, "nd799xy04.ome.tif"), aut = path.join(fixture, "Marginalized positions.aut");
const executablePath = path.join(bundle, "Contents/MacOS/Loci");
const identity = JSON.parse(await fs.readFile(path.join(bundle, "Contents/Resources/loci-build-identity.json")));
assert.match(process.env.LOCI_QA_SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/u);
assert.equal(identity.sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);
await plainFile(source, "Prepared publisher source");
await plainFile(aut, "Publisher .aut");
const sourceHash = await sha256(source);
assert.equal(sourceHash, "d794ae080e3262114172f20a610131a0ad4bcdc680afe05ff4c37ad84ec62216");
assert.equal(await sha256(aut), "6147a70cb0e7b6783253f936dbcdddd2ac7f3e48a211e38c39b27fc224793278");
const links = JSON.parse(await fs.readFile(aut, "utf8")).links.links;
const low = links.filter(link => link.marginal_probability < .99);
assert.equal(low.length, 81);
await fs.mkdir(out, { mode: 0o700 });
const saved = path.join(out, "saved.loci-study");
let app;
let pinned;
const report = { revision: identity.sourceRevision, source_sha256: sourceHash, phases: [] };
try {
  for (const phase of ["import", "reopen"]) {
    const session = await launch(path.join(out, phase + "-profile"), [], { executablePath });
    app = session.app;
    const page = session.page;
    await app.evaluate(({ dialog }, routes) => {
      const pick = (options) => {
        const filename = routes[options.title];
        if (!filename) throw new Error("Unexpected OrganoidTracker QA picker");
        return filename;
      };
      dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [pick(args.at(-1))] });
      dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: pick(args.at(-1)) });
    }, phase === "import" ? { "Create research study": path.join(out,"initial.loci-study"),
      "Save research study as": saved, "Add microscopy or medical images": source,
      "Choose an OrganoidTracker v1 graph": aut } : { "Open research study": saved });
    if (phase === "import") {
      await createEmptyStudy(page);
      await fileMenuAction(page, "Add images…");
    } else {
      await page.getByRole("button", {name:"Open study",exact:true}).click();
    }
    const snapshot = await waitForSnapshot(page, s => s?.sources?.length === 1, "publisher image", 120_000);
    const image = snapshot.sources[0];
    assert.equal(image.sha256, sourceHash);
    if (phase === "reopen") assert.equal(image.id, pinned.source_id);
    const toPlane = page.getByRole("button", {name: "2D image", exact: true});
    if (await toPlane.isVisible()) await toPlane.click();
    await selectWorkbenchTool(page, "Temporal");
    const panel = page.getByRole("region", {name: "OrganoidTracker lineage"});
    if (phase === "import") {
      await panel.getByLabel(/time point at the first image frame/).fill("0");
      await panel.getByLabel("Graph origin").selectOption("model-output");
      await panel.getByRole("checkbox").check();
      await panel.getByRole("button", {name:"Choose .aut graph…"}).click();
    } else {
      await panel.getByRole("button", {name:"Inspect saved graph"}).click({timeout:120_000});
    }
    await panel.getByText(/6802 positions · 6665 links · 48 branch parents/).waitFor({timeout:120_000});
    await panel.getByText("Graph identity",{exact:true}).click();
    const binding = JSON.parse(await panel.locator("details pre").innerText());
    assert.equal(binding.source_id, image.id);
    assert.equal(binding.graph_id, binding.graph_sha256.slice(0,32));
    if (phase === "import") pinned = binding;
    else assert.deepEqual(binding, pinned);
    await panel.getByLabel("Inspect links").selectOption("branches");
    await panel.getByText(/Link 1 of 96 ·/).waitFor();
    await panel.getByLabel("Inspect links").selectOption("low");
    await panel.getByText(/Link 1 of 81 ·/).waitFor();
    const endpoint = low[0].target;
    await panel.getByRole("button",{name:"View later source plane"}).click();
    await waitForSnapshot(page, s => {
      const state = s?.displays?.find(d => d.id === image.id)?.data?.state;
      return state?.selection?.t === endpoint._time_point_number && state.selection.z === Math.round(endpoint.z)
        && state.projection === "plane";
    }, "low-marginal link target source coordinates", 120_000);
    const viewport = page.locator('[data-viewer-source="'+image.id+'"][data-prepared="true"]');
    await viewport.waitFor({timeout:120_000});
    await page.screenshot({path:path.join(out,phase+".png")});
    report.phases.push({phase,binding,endpoint});
    if (phase === "import") {
      await fileMenuAction(page, "Save study");
      await page.getByText("Saved locally",{exact:true}).waitFor({timeout:120_000});
    }
    await close(app); app = null;
  }
  await fs.writeFile(path.join(out, "receipt.json"), JSON.stringify(report,null,2)+"\n");
} finally {
  if (app) await close(app);
}
