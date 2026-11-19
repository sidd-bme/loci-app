/** Reproduce a saved synthetic Components result from the actual packaged clipboard and CLI. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { selectResultSection, selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const appPath = await fs.realpath(process.env.LOCI_PACKAGED_APP);
const identityFile = "Resources/loci-build-identity.json";
const contents = path.join(appPath, "Contents");
const identity = JSON.parse(await fs.readFile(path.join(contents, identityFile), "utf8"));
assert.equal(identity.sourceDirty, false);
assert.equal(identity.sourceRevision, process.env.LOCI_QA_SOURCE_COMMIT);
const outputRoot = process.env.LOCI_QA_OUTPUT_ROOT;
assert.ok(path.isAbsolute(outputRoot));
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, "cli-replay-"));
const image = path.join(output, "fixture.ome.tiff");
const study = path.join(output, "Replay.loci-study");
const appCli = path.join(contents, "Resources/bin/loci");
const oracleScript = path.join(repo, "scripts/fixtures/recipe_replay.py");
const fixturePython = process.env.LOCI_QA_PYTHON ?? path.join(repo, "engine/.venv/bin/python");
const commandEnv = { ...process.env, LOCI_MODEL_HOME: path.join(output, "models") };
delete commandEnv.PYTHONPATH;
delete commandEnv.ELECTRON_RUN_AS_NODE;
const processOptions = { cwd: output, env: commandEnv, maxBuffer: 8 * 1024 * 1024, timeout: 120000 };
const json = async (executable, args) => JSON.parse((await exec(executable, args, processOptions)).stdout);
const cli = (command, args = []) => json(appCli, [command, "--project", study, ...args, "--json"]);
const oracle = (...args) => json(fixturePython, [oracleScript, ...args]);
const snapshot = () => oracle("snapshot", study, image);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const receipt = { status: "running", identity, appPath, started_at: new Date().toISOString(), checks: [] };
let app;
try {
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], processOptions);
  receipt.hashes = {};
  for (const entry of ["MacOS/Loci", "Resources/app.asar", "Resources/loci-engine/loci-engine", identityFile, "Resources/bin/loci"]) {
    receipt.hashes[entry] = sha256(await fs.readFile(path.join(contents, entry)));
  }
  const fixture = await oracle("generate", image);
  await cli("create", ["--title", "Synthetic replay"]);
  const imported = await cli("import", [image]);
  const source = imported.sources[0];
  assert.equal(source.sha256, fixture.source_sha256);
  const selection = { x: 2, y: 2, width: 26, height: 26, t: 0, c: 0, z: 0, level: 0 };
  const seed = { source_id: source.id, selection, recipe: {
    steps: [{ op: "subtract_constant", value: 10, clip_negative: true }],
    segmentation: { method: "components", threshold: 80, polarity: "bright", min_size: 4, exclude_border: false },
    measurement_channels: [0, 1], gates: [], working_bytes: 64 * 1024 ** 2,
  } };
  await fs.writeFile(path.join(output, "original.json"), JSON.stringify(seed));
  const submit = (file, key) => cli("submit", ["--operation", "run_recipe", "--request", "@" + file, "--request-key", key, "--run"]);
  const original = (await submit("original.json", "original")).result;
  await cli("review", ["--result", original.id, "--revision", original.revision_hash, "--disposition", "reviewed"]);
  app = await electron.launch({ executablePath: path.join(contents, "MacOS/Loci"),
    args: ["--user-data-dir=" + path.join(output, "profile")], env: commandEnv, timeout: 120000 });
  await app.evaluate(({ dialog }, selectedStudy) => {
    dialog.showOpenDialog = async (...args) => {
      const match = args.at(-1)?.title === "Open research study";
      return { canceled: !match, filePaths: match ? [selectedStudy] : [] };
    };
  }, study);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await waitForSnapshot(page, value => value?.results?.some(result => result.id === original.id), "saved original");
  await page.locator('button[data-result-id="' + original.id + '"]').click();
  await selectWorkbenchTool(page, "Info");
  await selectResultSection(page, "Review");
  await page.getByText("Analysis details", { exact: true }).click();
  const before = await snapshot();
  const copy = async (name, confirmation) => {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: confirmation, exact: true }).waitFor();
    // Only read after the application confirms a successful user-initiated copy.
    return app.evaluate(({ clipboard }) => clipboard.readText());
  };
  const envelope = JSON.parse(await copy("Copy analysis request", "Request copied"));
  const recipeText = await copy("Copy CLI recipe JSON", "CLI recipe copied");
  const request = JSON.parse(recipeText);
  assert.deepEqual(envelope, { operation: "run_recipe", request });
  assert.deepEqual(request, seed);
  await fs.writeFile(path.join(output, "recipe.json"), recipeText);
  await page.screenshot({ path: path.join(output, "result-panel.png") });
  assert.deepEqual(await snapshot(), before, "Copy must preserve all original scientific and job state");
  receipt.checks.push("User copied envelope and verbatim CLI request through the packaged result panel");
  const preflight = await cli("execute", ["recipe_preflight", "--request", "@recipe.json"]);
  const producing = JSON.parse(before.results[original.id]);
  assert.equal(preflight.recipe_sha256, producing.provenance.recipe_sha256);
  assert.equal(preflight.within_budget, true);
  assert.deepEqual(preflight.selection, producing.provenance.selection);
  assert.equal(preflight.source_sha256, fixture.source_sha256);
  const replay = await submit("recipe.json", "intentional-new-run");
  const retry = await submit("recipe.json", "intentional-new-run");
  assert.notEqual(replay.result.id, original.id);
  assert.equal(replay.job.state, "succeeded");
  assert.equal(retry.job.id, replay.job.id);
  assert.deepEqual(retry.job.result_ids, [replay.result.id]);
  const after = await snapshot();
  assert.equal(after.source_sha256, before.source_sha256);
  assert.deepEqual(after.sources, before.sources);
  assert.equal(after.results[original.id], before.results[original.id]);
  assert.ok(before.metadata["review:" + original.id]);
  assert.equal(after.metadata["review:" + original.id], before.metadata["review:" + original.id]);
  assert.equal(after.metadata["review:" + replay.result.id], undefined);
  assert.equal(Object.keys(after.results).length, 2);
  assert.equal(Object.keys(after.jobs).length, 2);
  const statePath = path.join(output, "state.json");
  await fs.writeFile(statePath, JSON.stringify(after));
  receipt.numerical = await oracle("verify", study, statePath, original.id, replay.result.id);
  receipt.checks.push("Bundled CLI preflight, new run and idempotent retry", "Original review, source bytes and numerical results");
  // Keep the live panel open across a change to our disposable source only.
  await fs.appendFile(image, "synthetic stale-source probe");
  await page.getByRole("button", { name: "CLI recipe copied", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: /changed|unavailable|verif/i }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Copy CLI recipe JSON|CLI recipe copied/ }).count(), 0);
  receipt.checks.push("Stale source refused during fresh verification");
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = String(error);
  throw error;
} finally {
  try {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => {});
      await app.close();
    }
  }
  finally {
    receipt.completed_at = new Date().toISOString();
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(output, receipt.status);
  }
}
