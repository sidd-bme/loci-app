/** Packaged publisher-graph journey. The lead runs this with the secondary-display loader.
 * Dialog responses are simulated. All import, inspection, plane and save actions use the UI.
 * LOCI_PACKAGED_APP, LOCI_QA_OUTPUT_ROOT (new directory), LOCI_QA_ORGANOID_FIXTURE
 * (the prepared publisher pair), LOCI_QA_SOURCE_COMMIT, LOCI_QA_SECONDARY_DISPLAY.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { close, dialogCalls, fileIdentity, launch, plainFile, requiredPath, visible, waitFor } from "./research-model-workbench.qa.mjs";
import { createEmptyStudy, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const CREATE = "Create research study";
const ADD = "Add microscopy or medical images";
const GRAPH = "Choose an OrganoidTracker v1 graph";
const SAVE = "Save research study as";
const OPEN = "Open research study";
const FIRST = 0;

const fixture = requiredPath("LOCI_QA_ORGANOID_FIXTURE");
const source = path.join(fixture, "nd799xy04.ome.tif");
const aut = path.join(fixture, "Marginalized positions.aut");
await plainFile(source, "Prepared publisher source");
await plainFile(aut, "Publisher .aut");
const sourceFile = await fileIdentity(source);
const graphFile = await fileIdentity(aut);
assert.equal(sourceFile.sha256, "d794ae080e3262114172f20a610131a0ad4bcdc680afe05ff4c37ad84ec62216");
assert.equal(graphFile.sha256, "6147a70cb0e7b6783253f936dbcdddd2ac7f3e48a211e38c39b27fc224793278");
const graph = JSON.parse(await fs.readFile(aut, "utf8"));
assert.equal(graph.links.nodes.length, 6802);
assert.equal(graph.links.links.length, 6665);
const low = graph.links.links.filter(link => typeof link.marginal_probability === "number" && link.marginal_probability < 0.99);
assert.equal(low.length, 81);
const firstLink = low[0];
const [earlier, endpoint] = [firstLink.source, firstLink.target].sort((a, b) => a._time_point_number - b._time_point_number);

assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--fixture-preflight"));
if (process.argv[2] === "--fixture-preflight") {
  console.log(JSON.stringify({ source: sourceFile, graph: graphFile, lowMarginalLinks: low.length, endpoint }));
} else {
  await journey();
}

async function installPickers(app, routes) {
  await app.evaluate(({ dialog }, expected) => {
    const calls = globalThis.__lociModelQaDialogCalls = [];
    const queue = [...expected];
    const pick = (kind, { title, properties }) => {
      calls.push({ kind, title });
      const route = queue.shift();
      if (route?.kind !== kind || route.title !== title || (route.property && !properties?.includes(route.property))) {
        throw new Error(`Unexpected OrganoidTracker QA picker: ${title}`);
      }
      return route.file;
    };
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [pick("open", args.at(-1))] });
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: pick("save", args.at(-1)) });
  }, routes);
}

async function chooseFileAction(header, name) {
  const menu = header.locator("details.workbench-file-menu");
  await menu.locator(":scope > summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
}

async function journey() {
  assert.equal(process.platform, "darwin");
  assert.ok(process.env.LOCI_QA_SECONDARY_DISPLAY && process.env.NODE_OPTIONS?.includes("secondary-display-loader.mjs"));
  const bundle = requiredPath("LOCI_PACKAGED_APP");
  const out = requiredPath("LOCI_QA_OUTPUT_ROOT");
  const executablePath = path.join(bundle, "Contents/MacOS/Loci");
  const identity = JSON.parse(await fs.readFile(path.join(bundle, "Contents/Resources/loci-build-identity.json"), "utf8"));
  assert.match(process.env.LOCI_QA_SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(identity.sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);
  await fs.mkdir(out, { mode: 0o700 });
  const saved = path.join(out, "saved.loci-study");
  let app;
  let pinned;
  let projectId;
  let stage;
  const report = { revision: identity.sourceRevision, source_sha256: sourceFile.sha256, graph_file_sha256: graphFile.sha256, phases: [] };
  try {
    for (const phase of ["import", "reopen"]) {
      stage = `${phase}: launch`;
      const session = await launch(path.join(out, `${phase}-profile`), [], { executablePath });
      app = session.app;
      const page = session.page;
      const workspace = page.getByRole("main", { name: "Research workspace", exact: true });
      const header = workspace.locator(":scope > header");
      const importing = phase === "import";
      const pickers = importing ? [
        { kind: "save", title: CREATE, file: path.join(out, "initial.loci-study") },
        { kind: "open", title: ADD, property: "openFile", file: source },
        { kind: "open", title: GRAPH, property: "openFile", file: aut },
        { kind: "save", title: SAVE, file: saved },
      ] : [{ kind: "open", title: OPEN, property: "openDirectory", file: saved }];
      await installPickers(app, pickers);

      stage = `${phase}: open publisher image`;
      if (importing) {
        await createEmptyStudy(page);
        await header.getByRole("button", { name: "Add images…", exact: true }).click();
      } else {
        await page.getByRole("main", { name: "Loci workspace", exact: true })
          .getByRole("button", { name: "Open study", exact: true }).click();
      }
      const snapshot = await waitForSnapshot(page, s => s?.sources?.length === 1, "publisher image", 120_000);
      const image = snapshot.sources[0];
      assert.equal(image.name, path.basename(source));
      assert.equal(image.sha256, sourceFile.sha256);
      assert.equal(image.size_bytes, sourceFile.size_bytes);
      assert.equal(image.source_kind, "native");
      assert.equal(image.locator_state, undefined);
      assert.match(image.id, /^[a-f0-9]{32}$/u);
      if (importing) {
        projectId = snapshot.project.project_id;
        assert.ok(projectId);
      } else {
        assert.equal(snapshot.project.project_id, projectId);
        assert.equal(image.id, pinned.source_id);
      }
      const imageView = workspace.getByRole("group", { name: "Image view", exact: true });
      const toPlane = imageView.getByRole("button", { name: "2D image", exact: true });
      await imageView.waitFor();
      if (await toPlane.isVisible()) await toPlane.click();

      stage = `${phase}: Model Zoo route`;
      await chooseFileAction(header, "Model Zoo…");
      const zoo = page.getByRole("dialog", { name: "Model Zoo", exact: true });
      await zoo.locator('article[data-model-id="organoidtracker-2"]')
        .getByRole("button", { name: "OrganoidTracker 2.0", exact: true }).click();
      await zoo.getByRole("button", { name: "Open Track over time", exact: true }).click();
      await zoo.waitFor({ state: "hidden" });

      stage = `${phase}: ${importing ? "import graph" : "load saved graph"}`;
      const panel = workspace.getByRole("region", { name: "OrganoidTracker lineage", exact: true });
      if (importing) {
        await panel.getByLabel("Upstream time point at the first image frame", { exact: true }).fill(String(FIRST));
        await panel.getByLabel("Graph origin", { exact: true }).selectOption("model-output");
        await panel.getByRole("checkbox", { name: "These are selected tracks for this image series, frame numbering and native pixel grid.", exact: true }).check();
        await panel.getByRole("button", { name: "Choose .aut graph…", exact: true }).click();
      } else {
        await panel.getByLabel("Saved graph", { exact: true }).selectOption(pinned.graph_id, { timeout: 120_000 });
        await panel.getByRole("button", { name: "Inspect saved graph", exact: true }).click();
      }
      await waitFor(page, async () => {
        const alert = panel.getByRole("alert");
        if (await alert.isVisible()) throw new Error(await alert.innerText());
        return panel.getByText("6802 positions · 6665 links · 48 branch parents", { exact: true }).isVisible();
      }, Boolean, "publisher graph counts", 120_000);
      await panel.getByText("Graph identity", { exact: true }).click();
      const binding = JSON.parse(await panel.locator("details pre").innerText());
      assert.equal(binding.source_id, image.id);
      assert.equal(binding.source_sha256, image.sha256);
      assert.match(binding.graph_sha256, /^[a-f0-9]{64}$/u);
      assert.equal(binding.graph_id, binding.graph_sha256.slice(0, 32));
      await panel.getByText(`Declared origin model-output · Graph ${binding.graph_id.slice(0, 12)}`, { exact: true }).waitFor();
      if (importing) pinned = binding;
      else assert.deepEqual(binding, pinned);

      stage = `${phase}: verify and locate link`;
      const filter = panel.getByLabel("Inspect links", { exact: true });
      await filter.selectOption("branches");
      await panel.getByText(/^Link 1 of 96 ·/).waitFor();
      await filter.selectOption("low");
      await panel.getByText(`Link 1 of 81 · Reported link probability ${firstLink.link_probability ?? "unavailable"} · Marginal probability ${firstLink.marginal_probability}`, { exact: true }).waitFor();
      for (const [direction, node] of [["From", earlier], ["To", endpoint]]) {
        const t = node._time_point_number;
        const { x, y, z } = node;
        const seconds = (t - FIRST) * (graph.image_resolution.t_m * 60);
        const calibrated = ["x", "y", "z"].map(axis => Number((node[axis] * graph.image_resolution[`${axis}_um`]).toPrecision(6)));
        await panel.getByText(`${direction} upstream time ${t} · ${seconds} s · XYZ ${x}, ${y}, ${z} px · ${calibrated.join(", ")} µm`, { exact: true }).waitFor();
      }
      await panel.getByRole("button", { name: "View later source plane", exact: true }).click({ timeout: 120_000 });
      await waitForSnapshot(page, s => {
        const state = s?.displays?.find(d => d.id === image.id)?.data?.state;
        return state?.selection?.t === endpoint._time_point_number - FIRST && state.selection.z === Math.round(endpoint.z)
          && state.projection === "plane";
      }, "low-marginal link target source coordinates", 120_000);
      const viewport = workspace.locator(`.image-viewport[data-viewer-source="${image.id}"][data-prepared="true"]`);
      await visible(page, viewport.locator("canvas"), "exact source plane", 120_000);
      await page.screenshot({ path: path.join(out, `${phase}.png`) });

      if (importing) {
        stage = `${phase}: save a study copy`;
        const database = path.join(saved, "study.sqlite3");
        await chooseFileAction(header, "Save as study…");
        await waitFor(page, () => fs.lstat(database).catch(error => {
          if (error.code !== "ENOENT") throw error;
          return null;
        }), Boolean, "saved study database", 120_000);
        await plainFile(database, "Saved study database");
        await visible(page, header.getByText("Saved locally", { exact: true }), "saved study");
      }
      const calls = await dialogCalls(app);
      assert.deepEqual(calls, pickers.map(({ kind, title }) => ({ kind, title })));
      report.phases.push({ phase, binding, endpoint, earlier, link_probability: firstLink.link_probability ?? null,
        marginal_probability: firstLink.marginal_probability, pickers: calls });
      await close(app);
      app = null;
    }
    stage = "verify original fixture identity";
    assert.deepEqual(await fileIdentity(source), sourceFile);
    assert.deepEqual(await fileIdentity(aut), graphFile);
    await fs.writeFile(path.join(out, "receipt.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(`OrganoidTracker QA failed during ${stage}: ${error.message}`, { cause: error });
  } finally {
    if (app) await close(app);
  }
}
